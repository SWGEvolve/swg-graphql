import { Service } from 'typedi';
import esb, { Query } from 'elastic-builder';
import { mergeWith } from 'lodash';
import { ENABLE_TEXT_SEARCH } from '@core/config';
import { elasticClient } from '@core/utils/elasticClient';

import { GALAXY_SEARCH_INDEX_NAME } from '../config';
import { SearchDocument } from '../types';

function concatIfArray<T>(objValue: T, srcValue: T) {
  if (Array.isArray(objValue)) {
    return objValue.concat(srcValue);
  }
}
interface IntRangeQueryWithCustomKey {
  key: string;
  gte?: number;
  lte?: number;
}

interface StringRangeQuery {
  gte?: string;
  lte?: string;
}

interface SearchFilters {
  searchText: string;
  searchTextIsEsQuery: boolean;
  types?: string[]; // SearchDocument['type'][];
  resourceAttributes?: IntRangeQueryWithCustomKey[];
  resourceDepletionDate?: StringRangeQuery;
  from: number;
  size: number;
}

@Service()
export class SearchService {
  private elastic = elasticClient;

  private async findElasticRecords(filters: SearchFilters) {
    const searchText = filters.searchText.trim();

    const scoreFunctionQuery = esb
      .functionScoreQuery()
      .functions([
        esb.weightScoreFunction().filter(esb.matchQuery('id', searchText)).weight(100),
        esb.weightScoreFunction().filter(esb.matchQuery('type', 'Account')).weight(30),
        esb.weightScoreFunction().filter(esb.existsQuery('stationId')).weight(10),
      ])
      .boostMode('multiply');

    const mustQueries: Query[] = [];
    const shouldQueries: Query[] = [];
    const filterQueries: Query[] = [];

    if (!searchText && !filters.types) {
      mustQueries.push(esb.matchNoneQuery());
    }

    if (filters.types) {
      mustQueries.push(
        esb
          .boolQuery()
          .should(filters.types.map(t => esb.termQuery('type', t)))
          .minimumShouldMatch(1)
      );
    }

    if (searchText && !filters.searchTextIsEsQuery) {
      mustQueries.push(
        esb
          .disMaxQuery()
          .queries([
            esb.multiMatchQuery().type('phrase').analyzer('keyword').query(searchText).boost(100),
            esb
              .multiMatchQuery()
              .query(searchText)
              .type('phrase_prefix')
              .fields(['basicName^2', 'objectName^2', 'accountName^2', 'resourceName', '*']),
            esb
              .multiMatchQuery()
              .query(searchText)
              .fuzziness('AUTO')
              .fields(['accountName^2', 'resourceName', 'resourceClass', 'resourceClassId', '*']),
            esb.multiMatchQuery().query(searchText).fields(['id^10', 'stationId^5', '*']),
          ])
          .tieBreaker(1.0)
      );
    }

    if (filters.resourceAttributes) {
      filters.resourceAttributes.forEach(ra => {
        const query = esb.rangeQuery(`resourceAttributes.${ra.key}`);

        if (ra.gte) query.gte(ra.gte);
        if (ra.lte) query.lte(ra.lte);

        filterQueries.push(query);
      });
    }

    if (filters.resourceDepletionDate) {
      const rdd = filters.resourceDepletionDate;

      const query = esb.rangeQuery(`resourceDepletedTime`);

      if (rdd.gte) query.gte(rdd.gte);
      if (rdd.lte) query.lte(rdd.lte);

      filterQueries.push(query);
    }

    let elasticQuery = scoreFunctionQuery
      .query(esb.boolQuery().must(mustQueries).filter(filterQueries).should(shouldQueries))
      .toJSON();

    if (filters.searchTextIsEsQuery && searchText) {
      const parsedEsQuery = JSON.parse(searchText);

      if (parsedEsQuery.multi_match)
        elasticQuery = mergeWith(
          elasticQuery,
          {
            // eslint-disable-next-line camelcase
            function_score: {
              query: {
                bool: {
                  should: [parsedEsQuery],
                },
              },
            },
          },
          concatIfArray
        );
      else {
        elasticQuery = mergeWith(
          elasticQuery,
          {
            // eslint-disable-next-line camelcase
            function_score: {
              query: parsedEsQuery,
            },
          },
          concatIfArray
        );
      }
    }

    const elasticResponse = await this.elastic.search<SearchDocument>({
      index: GALAXY_SEARCH_INDEX_NAME,
      size: filters.size,
      from: filters.from,
      query: elasticQuery,
    });

    return elasticResponse;
  }

  async search(filters: SearchFilters) {
    if (!ENABLE_TEXT_SEARCH) {
      return null;
    }

    const results = await this.findElasticRecords(filters);

    return results;
  }
}
