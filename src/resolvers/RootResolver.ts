import { Arg, Int, Query, Resolver, ID } from 'type-graphql';
import { Service } from 'typedi';
import { chunk } from 'lodash';
import { flatMapLimit } from 'async';

import { GuildService } from '../services/GuildService';
import { CityService } from '../services/CityService';
import { SearchService } from '../services/SearchService';
import { ServerObjectService } from '../services/ServerObjectService';
import { PlayerCreatureObjectService, PlayerRecord } from '../services/PlayerCreatureObjectService';
import { ResourceTypeService } from '../services/ResourceTypeService';
import {
  IServerObject,
  UnenrichedServerObject,
  SearchResultDetails,
  Account,
  Guild,
  City,
  PlayerCreatureObject,
} from '../types';
import { ResourceType, ResourceTypeResult } from '../types/ResourceType';
import { DateRangeInput, IntRangeInput } from '../types/SearchResult';
import { isPresent } from '../utils/utility-types';
import TAGIFY from '../utils/tagify';

@Service()
@Resolver()
export class RootResolver {
  constructor(
    // constructor injection of a service
    private readonly objectService: ServerObjectService,
    private readonly searchService: SearchService,
    private readonly guildService: GuildService,
    private readonly cityService: CityService,
    private readonly resourceTypeService: ResourceTypeService,
    private readonly playerCreatureService: PlayerCreatureObjectService
  ) {
    // Do nothing
  }

  @Query(() => IServerObject, { nullable: true })
  object(@Arg('objectId', { nullable: false }) objectId: string): Promise<Partial<IServerObject> | null> {
    return this.objectService.getOne(objectId);
  }

  @Query(() => [IServerObject], { nullable: true })
  objects(
    @Arg('limit', () => Int, { defaultValue: 50 }) limit: number,
    @Arg('excludeDeleted', { defaultValue: false }) excludeDeleted: boolean,
    @Arg('objectIds', () => [ID], { nullable: true }) objectIds?: string[],
    @Arg('loadsWithIds', () => [ID], { nullable: true }) loadsWithIds?: string[],
    @Arg('searchText', { nullable: true }) searchText?: string
  ): Promise<Partial<UnenrichedServerObject[]> | null> {
    return this.objectService.getMany({ searchText, limit, excludeDeleted, objectIds, loadsWithIds });
  }

  @Query(() => Account, { nullable: true })
  account(@Arg('stationId', { nullable: false }) accountId: string) {
    return Object.assign(new Account(), {
      id: parseInt(accountId),
    });
  }

  @Query(() => SearchResultDetails, { nullable: false })
  async search(
    @Arg('searchText', { nullable: false }) searchText: string,
    @Arg('from', () => Int, { defaultValue: 0 }) from: number,
    @Arg('size', () => Int, { defaultValue: 25 }) size: number,
    @Arg('types', () => [String], { nullable: true }) types?: string[],
    @Arg('resourceAttributes', () => [IntRangeInput], { nullable: true }) resourceAttributes?: IntRangeInput[],
    @Arg('resourceDepletionDate', () => DateRangeInput, { nullable: true }) resourceDepletionDate?: DateRangeInput
  ): Promise<SearchResultDetails> {
    const rawResults = await this.searchService.search({
      searchText,
      from,
      size,
      types,
      resourceAttributes,
      resourceDepletionDate,
    });

    if (!rawResults)
      return {
        totalResultCount: 0,
        results: null,
      };

    const results = await Promise.all(
      rawResults.hits.hits.flatMap(result => {
        if (!result._source || !result._source.id) return [];

        if (result._source.type === 'Object') {
          return this.objectService.getOne(result._source.id);
        }

        if (result._source.type === 'ResourceType') {
          return this.resourceTypeService.getOne(result._source.id);
        }

        if (result._source.type === 'Account') {
          return Object.assign(new Account(), {
            id: parseInt(result._source.id),
          });
        }

        return null;
      })
    );

    if (searchText.trim().match(/^\d+$/) && results.length === 0) {
      const exactOidMatch = await this.objectService.getOne(searchText.trim());

      if (exactOidMatch) results.push(exactOidMatch);
    }

    const presentResults = results.filter(isPresent);

    const total = rawResults?.hits?.total;
    const totalResultCount = (typeof total === 'object' ? total.value : total) ?? 0;

    return {
      totalResultCount,
      results: presentResults,
    };
  }

  @Query(() => [Guild])
  async guilds() {
    const guilds = await this.guildService.getAllGuilds();

    const guildsArr = [...guilds].map(([, val]) => val);

    return guildsArr;
  }

  @Query(() => Guild, { nullable: true })
  guild(@Arg('guildId', { nullable: false }) id: string) {
    return this.guildService.getGuild(id);
  }

  @Query(() => [City])
  async cities() {
    const cities = await this.cityService.getAllCities();

    const citiesArr = [...cities].map(([, val]) => val);

    return citiesArr;
  }

  @Query(() => City, { nullable: true })
  city(@Arg('cityId', { nullable: false }) id: string) {
    return this.cityService.getCity(id);
  }

  @Query(() => ResourceTypeResult)
  async resources(
    @Arg('limit', () => Int, { defaultValue: 50 }) limit: number,
    @Arg('offset', () => Int, { defaultValue: 0 }) offset: number
  ) {
    const filters = { limit, offset };

    const [count, results] = await Promise.all([
      this.resourceTypeService.countMany(filters),
      this.resourceTypeService.getMany(filters),
    ]);

    return {
      totalResults: count,
      results,
    };
  }

  @Query(() => ResourceType, { nullable: true })
  resource(@Arg('resourceId', { nullable: false }) id: string) {
    return this.resourceTypeService.getOne(id);
  }

  @Query(() => [PlayerCreatureObject])
  async recentLogins(
    @Arg('durationSeconds', () => Int, { defaultValue: 10 * 60 }) durationSeconds: number
  ): Promise<PlayerCreatureObject[]> {
    const results = await this.playerCreatureService.getRecentlyLoggedInCharacters(durationSeconds);

    const chunkedResults = chunk(results, 1000);
    const CONCURRENCY_LIMIT = 10;

    const objects = await flatMapLimit<PlayerRecord[], PlayerCreatureObject, Error>(
      chunkedResults,
      CONCURRENCY_LIMIT,
      playerRecords =>
        this.objectService.getMany({
          objectIds: playerRecords.map(r => r.CHARACTER_OBJECT.toString()),
          objectTypes: [TAGIFY('CREO')],
        }) as Promise<PlayerCreatureObject[]>
    );

    return objects;
  }
}
