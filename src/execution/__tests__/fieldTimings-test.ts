import { expect } from 'chai';
import { describe, it } from 'mocha';

import { parse } from '../../language/parser';

import {
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
} from '../../type/definition';
import { GraphQLInt, GraphQLString } from '../../type/scalars';
import { GraphQLSchema } from '../../type/schema';

import { graphql, graphqlSync } from '../../graphql';

import type { ExecutionResult, FieldTiming } from '../execute';
import { execute, executeSync } from '../execute';
import { subscribe } from '../subscribe';

import { SimplePubSub } from './simplePubSub';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function timingsOf(result: ExecutionResult): Array<FieldTiming> {
  return (result.extensions as { fieldTimings: Array<FieldTiming> })
    .fieldTimings;
}

describe('Execute: field timings', () => {
  const Review = new GraphQLObjectType({
    name: 'Review',
    fields: () => ({
      body: { type: GraphQLString },
      stars: { type: new GraphQLNonNull(GraphQLInt) },
    }),
  });

  const productDeferred = deferred<{ name: string }>();
  const reviewsDeferred = deferred<Array<{ body: string; stars: number }>>();

  const Product = new GraphQLObjectType({
    name: 'Product',
    fields: () => ({
      name: {
        type: GraphQLString,
        resolve(source) {
          return source.name;
        },
      },
      reviews: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(Review))),
        resolve: () => reviewsDeferred.promise,
      },
    }),
  });

  const Query = new GraphQLObjectType({
    name: 'Query',
    fields: {
      product: {
        type: Product,
        args: { id: { type: GraphQLString } },
        resolve: () => productDeferred.promise,
      },
      syncField: {
        type: GraphQLString,
        resolve: () => 'sync',
      },
      thrownField: {
        type: GraphQLString,
        resolve() {
          throw new Error('sync boom');
        },
      },
      rejectedField: {
        type: GraphQLString,
        resolve() {
          return Promise.reject(new Error('async boom'));
        },
      },
      defaultedField: {
        type: GraphQLString,
      },
      slowGetterField: {
        type: GraphQLString,
      },
    },
  });

  const schema = new GraphQLSchema({ query: Query });

  it('does not add extensions when the option is not provided', () => {
    const result = graphqlSync({
      schema,
      source: '{ syncField }',
    });
    expect(result).to.deep.equal({ data: { syncField: 'sync' } });
    expect('extensions' in result).to.equal(false);
  });

  it('does not add extensions when the option is false', () => {
    const result = graphqlSync({
      schema,
      source: '{ syncField }',
      fieldTimings: false,
    });
    expect(result).to.deep.equal({ data: { syncField: 'sync' } });
    expect('extensions' in result).to.equal(false);
  });

  it('records timings for synchronous fields via executeSync', () => {
    const result = executeSync({
      schema,
      document: parse('{ syncField }'),
      fieldTimings: true,
    });
    expect(result.data).to.deep.equal({ syncField: 'sync' });
    const [timing] = timingsOf(result);
    expect(timing).to.deep.include({
      path: ['syncField'],
      parentType: 'Query',
      fieldName: 'syncField',
      returnType: 'String',
    });
    expect(timing.startOffset).to.be.a('number');
    expect(timing.duration).to.be.a('number');
  });

  it('keeps graphqlSync synchronous when fieldTimings is enabled', () => {
    const result = graphqlSync({
      schema,
      source: '{ syncField }',
      fieldTimings: true,
    });
    expect(result.data).to.deep.equal({ syncField: 'sync' });
    expect(timingsOf(result)).to.have.lengthOf(1);
  });

  it('records one entry per executed field with names and types', async () => {
    const resultPromise = graphql({
      schema,
      source: `
        {
          aliased: product(id: "42") {
            displayName: name
            reviews {
              body
              stars
            }
          }
        }
      `,
      fieldTimings: true,
    });

    // Only the product resolver has run so far; sub-fields wait on it.
    await Promise.resolve();
    productDeferred.resolve({ name: 'Product 42' });
    await Promise.resolve();
    reviewsDeferred.resolve([
      { body: 'first', stars: 5 },
      { body: 'second', stars: 3 },
    ]);

    const result = await resultPromise;

    expect(result.errors).to.equal(undefined);
    const withoutMetrics = (timings: ReadonlyArray<FieldTiming>) =>
      timings.map(
        ({ startOffset: _startOffset, duration: _duration, ...rest }) => rest,
      );
    expect(withoutMetrics(timingsOf(result))).to.deep.equal([
      {
        path: ['aliased'],
        parentType: 'Query',
        fieldName: 'product',
        returnType: 'Product',
      },
      {
        path: ['aliased', 'displayName'],
        parentType: 'Product',
        fieldName: 'name',
        returnType: 'String',
      },
      {
        path: ['aliased', 'reviews'],
        parentType: 'Product',
        fieldName: 'reviews',
        returnType: '[Review!]!',
      },
      {
        path: ['aliased', 'reviews', 0, 'body'],
        parentType: 'Review',
        fieldName: 'body',
        returnType: 'String',
      },
      {
        path: ['aliased', 'reviews', 0, 'stars'],
        parentType: 'Review',
        fieldName: 'stars',
        returnType: 'Int!',
      },
      {
        path: ['aliased', 'reviews', 1, 'body'],
        parentType: 'Review',
        fieldName: 'body',
        returnType: 'String',
      },
      {
        path: ['aliased', 'reviews', 1, 'stars'],
        parentType: 'Review',
        fieldName: 'stars',
        returnType: 'Int!',
      },
    ]);
    for (const timing of timingsOf(result)) {
      expect(timing.startOffset).to.be.a('number');
      expect(timing.duration).to.be.a('number');
    }
  });

  it('uses response names and list indices matching error paths', async () => {
    const schemaWithBoom = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          list: {
            type: new GraphQLList(GraphQLString),
            resolve() {
              return ['ok', Promise.reject(new Error('item boom')), 'also ok'];
            },
          },
        },
      }),
    });

    const result = await execute({
      schema: schemaWithBoom,
      document: parse('{ l: list }'),
      fieldTimings: true,
    });

    expect(result.data).to.deep.equal({ l: ['ok', null, 'also ok'] });
    expect(result.errors?.[0].path).to.deep.equal(['l', 1]);
    // The list field itself is one timing entry using the alias.
    expect(timingsOf(result).map((t) => t.path)).to.deep.equal([['l']]);
  });

  it('records timing for fields resolved by the default resolver', () => {
    const result = executeSync({
      schema,
      document: parse('{ defaultedField slowGetterField }'),
      rootValue: {
        defaultedField: 'plain value',
        get slowGetterField() {
          const start = Date.now();
          while (Date.now() - start < 5) {
            /* busy wait */
          }
          return 'getter value';
        },
      },
      fieldTimings: true,
    });

    expect(result.data).to.deep.equal({
      defaultedField: 'plain value',
      slowGetterField: 'getter value',
    });
    expect(timingsOf(result).map((t) => t.fieldName)).to.deep.equal([
      'defaultedField',
      'slowGetterField',
    ]);
    const slowGetterTiming = timingsOf(result).find(
      (t) => t.fieldName === 'slowGetterField',
    );
    expect(slowGetterTiming?.duration).to.be.at.least(4);
  });

  it('records timing for fields that synchronously throw', () => {
    const result = executeSync({
      schema,
      document: parse('{ thrownField syncField }'),
      fieldTimings: true,
    });

    expect(result.data).to.deep.equal({ thrownField: null, syncField: 'sync' });
    expect(result.errors).to.have.lengthOf(1);
    expect(result.errors?.[0].path).to.deep.equal(['thrownField']);

    const timing = timingsOf(result).find((t) => t.fieldName === 'thrownField');
    expect(timing?.path).to.deep.equal(['thrownField']);
  });

  it('records timing for fields whose promise rejects', async () => {
    const result = await graphql({
      schema,
      source: '{ rejectedField syncField }',
      fieldTimings: true,
    });

    expect(result.errors).to.have.lengthOf(1);
    expect(result.errors?.[0].message).to.equal('async boom');
    expect(result.errors?.[0].path).to.deep.equal(['rejectedField']);

    const names = timingsOf(result).map((t) => t.fieldName);
    expect(names).to.include('rejectedField');
    expect(names).to.include('syncField');
  });

  it('excludes sub-field execution time from a resolver duration', async () => {
    const leafDeferred = deferred<string>();

    const Child = new GraphQLObjectType({
      name: 'Child',
      fields: {
        leaf: {
          type: GraphQLString,
          resolve: () => leafDeferred.promise,
        },
      },
    });
    const localSchema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          parent: {
            type: Child,
            resolve: () => Promise.resolve({}),
          },
        },
      }),
    });

    const resultPromise = graphql({
      schema: localSchema,
      source: '{ parent { leaf } }',
      fieldTimings: true,
    });

    // Let the parent resolver settle and the sub-selection start.
    await Promise.resolve();
    await Promise.resolve();
    // Busy-wait while only the leaf is pending. This time must be counted
    // against the leaf resolver, never against the parent's duration.
    const start = Date.now();
    while (Date.now() - start < 20) {
      /* busy wait */
    }
    leafDeferred.resolve('leaf');

    const result = await resultPromise;
    expect(result.data).to.deep.equal({ parent: { leaf: 'leaf' } });
    const timings = timingsOf(result);
    const parentTiming = timings.find((t) => t.fieldName === 'parent');
    const leafTiming = timings.find((t) => t.fieldName === 'leaf');
    expect(parentTiming?.duration).to.be.below(15);
    expect(leafTiming?.duration).to.be.at.least(15);
  });

  it('measures startOffset relative to the start of execution', async () => {
    const localDeferred = deferred<{ name: string }>();
    const localSchema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          product: {
            type: Product,
            resolve: () => localDeferred.promise,
          },
        },
      }),
    });

    const resultPromise = graphql({
      schema: localSchema,
      source: '{ product { name } }',
      fieldTimings: true,
    });
    await Promise.resolve();
    localDeferred.resolve({ name: 'widget' });
    const result = await resultPromise;

    const [productTiming, nameTiming] = timingsOf(result);
    expect(productTiming.startOffset).to.be.at.most(5);
    // name resolves only after the product promise settles, so it starts
    // strictly later in the execution timeline.
    expect(nameTiming.startOffset).to.be.greaterThan(productTiming.startOffset);
  });

  it('supports execute directly with a promise result', async () => {
    const localDeferred = deferred<{ name: string }>();
    const localSchema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          product: {
            type: Product,
            resolve: () => localDeferred.promise,
          },
        },
      }),
    });

    const resultPromise = execute({
      schema: localSchema,
      document: parse('{ product { name } }'),
      fieldTimings: true,
    });
    localDeferred.resolve({ name: 'widget' });
    const result = await resultPromise;
    expect(timingsOf(result)).to.have.lengthOf(2);
  });
});

describe('Subscribe: field timings', () => {
  it('includes timings for each event, isolated per event', async () => {
    const pubsub = new SimplePubSub<{ n: number }>();

    const Event = new GraphQLObjectType({
      name: 'Event',
      fields: {
        n: { type: new GraphQLNonNull(GraphQLInt) },
        doubled: {
          type: new GraphQLNonNull(GraphQLInt),
          resolve: (source: { n: number }) => source.n * 2,
        },
      },
    });
    const Subscription = new GraphQLObjectType({
      name: 'Subscription',
      fields: {
        event: {
          type: new GraphQLNonNull(Event),
          subscribe: () => pubsub.getSubscriber((event) => ({ event })),
        },
      },
    });
    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: { n: { type: GraphQLInt } },
      }),
      subscription: Subscription,
    });

    const subscription = await subscribe({
      schema,
      document: parse('subscription { event { n doubled } }'),
      fieldTimings: true,
    });
    expect(subscription).to.not.have.property('errors');

    const iterator = subscription as AsyncGenerator<
      ExecutionResult,
      void,
      void
    >;

    const first = iterator.next();
    pubsub.emit({ n: 1 });
    const firstResult = (await first).value as ExecutionResult;

    expect(firstResult.data).to.deep.equal({
      event: { n: 1, doubled: 2 },
    });
    expect(timingsOf(firstResult).map((t) => t.path)).to.deep.equal([
      ['event'],
      ['event', 'n'],
      ['event', 'doubled'],
    ]);

    const second = iterator.next();
    pubsub.emit({ n: 2 });
    const secondResult = (await second).value as ExecutionResult;

    expect(secondResult.data).to.deep.equal({
      event: { n: 2, doubled: 4 },
    });
    expect(timingsOf(secondResult).map((t) => t.path)).to.deep.equal([
      ['event'],
      ['event', 'n'],
      ['event', 'doubled'],
    ]);
    // Each event execution starts its own clock near zero.
    for (const timing of timingsOf(secondResult)) {
      expect(timing.startOffset).to.be.at.most(20);
    }
  });
});
