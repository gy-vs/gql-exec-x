import { expect } from 'chai';
import { describe, it } from 'mocha';

import { expectJSON } from '../../__testUtils__/expectJSON';

import { invariant } from '../../jsutils/invariant';
import { isAsyncIterable } from '../../jsutils/isAsyncIterable';

import { parse } from '../../language/parser';

import {
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
} from '../../type/definition';
import { GraphQLID, GraphQLInt, GraphQLString } from '../../type/scalars';
import { GraphQLSchema } from '../../type/schema';

import { graphql, graphqlSync } from '../../graphql';

import type { ExecutionResult, FieldTiming } from '../execute';
import { execute, executeSync } from '../execute';
import { subscribe } from '../subscribe';

import { SimplePubSub } from './simplePubSub';

declare const setTimeout: (callback: () => void, delay: number) => unknown;

const ReviewType = new GraphQLObjectType({
  name: 'Review',
  fields: {
    stars: { type: new GraphQLNonNull(GraphQLInt) },
    comment: { type: GraphQLString },
  },
});

const ProductType = new GraphQLObjectType({
  name: 'Product',
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    name: { type: GraphQLString },
    reviews: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(ReviewType))),
    },
    boom: {
      type: GraphQLString,
      resolve() {
        throw new Error('Boom');
      },
    },
    slow: {
      type: GraphQLString,
      resolve: () =>
        new Promise((resolve) => {
          setTimeout(() => resolve('slow'), 25);
        }),
    },
  },
});

const QueryType = new GraphQLObjectType({
  name: 'Query',
  fields: {
    product: {
      type: ProductType,
      resolve: () => ({
        id: 'p1',
        get name(): string {
          return 'Widget';
        },
        reviews: [{ stars: 5, comment: 'Great' }],
      }),
    },
    asyncValue: {
      type: GraphQLString,
      resolve: () =>
        new Promise((resolve) => {
          setTimeout(() => resolve('done'), 25);
        }),
    },
    asyncBoom: {
      type: GraphQLString,
      resolve: () => Promise.reject(new Error('AsyncBoom')),
    },
    nonNullBoom: {
      type: new GraphQLNonNull(GraphQLString),
      resolve() {
        throw new Error('Boom');
      },
    },
  },
});

const schema = new GraphQLSchema({ query: QueryType });

function getFieldTimings(result: ExecutionResult): ReadonlyArray<FieldTiming> {
  const timings = (
    result.extensions as
      | { fieldTimings?: ReadonlyArray<FieldTiming> }
      | undefined
  )?.fieldTimings;
  invariant(
    timings !== undefined,
    'Expected the result to contain field timings.',
  );
  return timings;
}

function timingAtPath(
  timings: ReadonlyArray<FieldTiming>,
  path: ReadonlyArray<string | number>,
): FieldTiming {
  const timing = timings.find(
    (candidate) => JSON.stringify(candidate.path) === JSON.stringify(path),
  );
  invariant(
    timing !== undefined,
    `Expected a timing entry at path ${JSON.stringify(path)}.`,
  );
  return timing;
}

describe('Execute: fieldTimings option', () => {
  it('does not change the result when the option is not used', () => {
    const source = '{ product { name boom } }';
    const expected = {
      data: { product: { name: 'Widget', boom: null } },
      errors: [
        {
          message: 'Boom',
          locations: [{ line: 1, column: 18 }],
          path: ['product', 'boom'],
        },
      ],
    };

    expectJSON(graphqlSync({ schema, source })).toDeepEqual(expected);
    expectJSON(
      graphqlSync({ schema, source, fieldTimings: false }),
    ).toDeepEqual(expected);
  });

  it('reports a timing entry for every executed field', () => {
    const result = graphqlSync({
      schema,
      source: '{ product { name reviews { stars } } }',
      fieldTimings: true,
    });

    expect(result).to.not.have.property('errors');

    const timings = getFieldTimings(result);
    expect(
      timings.map(({ path, parentType, fieldName, returnType }) => ({
        path,
        parentType,
        fieldName,
        returnType,
      })),
    ).to.deep.equal([
      {
        path: ['product'],
        parentType: 'Query',
        fieldName: 'product',
        returnType: 'Product',
      },
      {
        path: ['product', 'name'],
        parentType: 'Product',
        fieldName: 'name',
        returnType: 'String',
      },
      {
        path: ['product', 'reviews'],
        parentType: 'Product',
        fieldName: 'reviews',
        returnType: '[Review!]!',
      },
      {
        path: ['product', 'reviews', 0, 'stars'],
        parentType: 'Review',
        fieldName: 'stars',
        returnType: 'Int!',
      },
    ]);

    const rootTiming = timingAtPath(timings, ['product']);
    for (const timing of timings) {
      expect(timing.startOffset).to.be.a('number').and.to.be.at.least(0);
      expect(timing.duration).to.be.a('number').and.to.be.at.least(0);
      // Every field starts after the root field started.
      expect(timing.startOffset).to.be.at.least(rootTiming.startOffset);
    }
  });

  it('uses response names and list indices in paths', () => {
    const result = graphqlSync({
      schema,
      source: '{ item: product { title: name reviews { stars } } }',
      fieldTimings: true,
    });

    const paths = getFieldTimings(result).map((timing) => timing.path);
    expect(paths).to.deep.equal([
      ['item'],
      ['item', 'title'],
      ['item', 'reviews'],
      ['item', 'reviews', 0, 'stars'],
    ]);
  });

  it('records fields resolved by the default field resolver', () => {
    const result = graphqlSync({
      schema,
      source: '{ product { id name } }',
      fieldTimings: true,
    });

    const timings = getFieldTimings(result);
    expect(timings).to.have.lengthOf(3);
    expect(timingAtPath(timings, ['product', 'id'])).to.include({
      parentType: 'Product',
      fieldName: 'id',
      returnType: 'ID!',
    });
    expect(timingAtPath(timings, ['product', 'name'])).to.include({
      parentType: 'Product',
      fieldName: 'name',
      returnType: 'String',
    });
  });

  it('records meta fields like __typename', () => {
    const result = graphqlSync({
      schema,
      source: '{ __typename }',
      fieldTimings: true,
    });

    const timings = getFieldTimings(result);
    expect(timings).to.have.lengthOf(1);
    expect(timings[0]).to.include({
      parentType: 'Query',
      fieldName: '__typename',
      returnType: 'String!',
    });
    expect(timings[0].path).to.deep.equal(['__typename']);
  });

  it('measures the time until an async resolver settles', async () => {
    const result = await graphql({
      schema,
      source: '{ asyncValue }',
      fieldTimings: true,
    });

    const timings = getFieldTimings(result);
    expect(timings).to.have.lengthOf(1);
    expect(timings[0]).to.include({
      parentType: 'Query',
      fieldName: 'asyncValue',
      returnType: 'String',
    });
    // The resolver promise settles after roughly 25ms.
    expect(timings[0].duration).to.be.at.least(15);
  });

  it('does not include subfield execution time in a field duration', async () => {
    const result = await graphql({
      schema,
      source: '{ product { slow } }',
      fieldTimings: true,
    });

    const timings = getFieldTimings(result);
    const product = timingAtPath(timings, ['product']);
    const slow = timingAtPath(timings, ['product', 'slow']);

    // The subfield waits roughly 25ms, its parent does not.
    expect(slow.duration).to.be.at.least(15);
    expect(product.duration).to.be.lessThan(slow.duration);
  });

  it('keeps the timing entry and the error for a field that throws', () => {
    const result = graphqlSync({
      schema,
      source: '{ product { boom } }',
      fieldTimings: true,
    });

    expectJSON(result).toDeepNestedProperty('data', {
      product: { boom: null },
    });
    expectJSON(result).toDeepNestedProperty('errors', [
      {
        message: 'Boom',
        locations: [{ line: 1, column: 13 }],
        path: ['product', 'boom'],
      },
    ]);

    const timings = getFieldTimings(result);
    const boom = timingAtPath(timings, ['product', 'boom']);
    expect(boom).to.include({
      parentType: 'Product',
      fieldName: 'boom',
      returnType: 'String',
    });
    // The timing entry points at the same location as the error.
    expect(boom.path).to.deep.equal(result.errors?.[0].path);
  });

  it('keeps the timing entry and the error for a rejecting async resolver', async () => {
    const result = await graphql({
      schema,
      source: '{ asyncBoom }',
      fieldTimings: true,
    });

    expectJSON(result).toDeepNestedProperty('errors', [
      {
        message: 'AsyncBoom',
        locations: [{ line: 1, column: 3 }],
        path: ['asyncBoom'],
      },
    ]);

    const timings = getFieldTimings(result);
    expect(timings).to.have.lengthOf(1);
    expect(timings[0]).to.include({
      parentType: 'Query',
      fieldName: 'asyncBoom',
    });
    expect(timings[0].duration).to.be.at.least(0);
  });

  it('records timings when a non-null field error nulls the whole result', () => {
    const result = graphqlSync({
      schema,
      source: '{ nonNullBoom }',
      fieldTimings: true,
    });

    expect(result.data).to.equal(null);
    expect(result.errors).to.have.lengthOf(1);

    const timings = getFieldTimings(result);
    expect(timings.map((timing) => timing.fieldName)).to.deep.equal([
      'nonNullBoom',
    ]);
  });

  it('records timings for serially executed mutation fields', () => {
    const mutationSchema = new GraphQLSchema({
      query: QueryType,
      mutation: new GraphQLObjectType({
        name: 'Mutation',
        fields: {
          first: { type: GraphQLString, resolve: () => '1' },
          second: { type: GraphQLString, resolve: () => '2' },
        },
      }),
    });

    const result = graphqlSync({
      schema: mutationSchema,
      source: 'mutation { first second }',
      fieldTimings: true,
    });

    const timings = getFieldTimings(result);
    expect(
      timings.map((timing) => [timing.parentType, timing.fieldName]),
    ).to.deep.equal([
      ['Mutation', 'first'],
      ['Mutation', 'second'],
    ]);
  });

  it('is supported by execute and executeSync', async () => {
    const document = parse('{ product { id } }');

    const asyncResult = await execute({ schema, document, fieldTimings: true });
    expect(getFieldTimings(asyncResult)).to.have.lengthOf(2);

    const syncResult = executeSync({ schema, document, fieldTimings: true });
    expect(getFieldTimings(syncResult)).to.have.lengthOf(2);
  });

  it('keeps graphqlSync synchronous when the option is used', () => {
    const result = graphqlSync({
      schema,
      source: '{ product { id } }',
      fieldTimings: true,
    });

    expect(result).to.not.have.property('then');
    expect(getFieldTimings(result)).to.have.lengthOf(2);
  });

  it('does not add timings when the request never executes', async () => {
    const result = await graphql({
      schema,
      source: '{ unknownField }',
      fieldTimings: true,
    });

    expect(result).to.have.property('errors');
    expect(result).to.not.have.property('extensions');
  });

  it('reports timings per event for subscriptions', async () => {
    const pubsub = new SimplePubSub<string>();
    const subscriptionSchema = new GraphQLSchema({
      query: QueryType,
      subscription: new GraphQLObjectType({
        name: 'Subscription',
        fields: {
          message: {
            type: GraphQLString,
            subscribe: () => pubsub.getSubscriber((payload) => payload),
            resolve: (payload) => payload,
          },
        },
      }),
    });

    const stream = await subscribe({
      schema: subscriptionSchema,
      document: parse('subscription { message }'),
      fieldTimings: true,
    });
    invariant(isAsyncIterable(stream));

    pubsub.emit('first');
    const first = await stream.next();
    pubsub.emit('second');
    const second = await stream.next();
    await stream.return();

    invariant(!first.done);
    invariant(!second.done);
    expectJSON(first.value).toDeepNestedProperty('data', {
      message: 'first',
    });
    expectJSON(second.value).toDeepNestedProperty('data', {
      message: 'second',
    });

    // Each event carries only the timings of its own execution.
    const firstTimings = getFieldTimings(first.value);
    const secondTimings = getFieldTimings(second.value);
    expect(firstTimings).to.have.lengthOf(1);
    expect(secondTimings).to.have.lengthOf(1);
    expect(firstTimings[0]).to.include({
      parentType: 'Subscription',
      fieldName: 'message',
      returnType: 'String',
    });
    expect(firstTimings[0].path).to.deep.equal(['message']);
    expect(secondTimings[0].path).to.deep.equal(['message']);
  });
});
