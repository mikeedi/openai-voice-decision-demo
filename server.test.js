import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { createApp, shares } from './server.js';

const options = ['Поезд', 'Самолёт', 'Автобус'].map((label, i) => ({ id: `o${i}`, label }));
const state = (extra = {}) => ({ options, context: 'Хочу недорого и без перелёта.', ...extra });
const advice = (excluded = []) => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({
  notes: options.map((o) => ({ id: o.id, reason: 'Учитывает ваши условия', excluded: excluded.includes(o.id) })),
  question: null, suggestion: null,
}) }] }] });
const decision = (values = [0.5, 0.3, 0.2], enough = 0.9) => ({ answers: [
  { name: 'enough_context', type: 'predicate', probability: enough },
  { name: 'preference', type: 'choice', probabilities: values.map((probability, i) => ({ value: `o${i}`, probability })) },
] });

async function app(t, replies = [], extra = {}) {
  const calls = [];
  const env = { OPENAI_API_KEY: 'test-secret', ...extra };
  const server = createApp({ env, fetch: async (url, init) => {
    calls.push({ url, ...init, body: JSON.parse(init.body) });
    assert.ok(replies.length, 'Unexpected paid API request');
    return Response.json(replies.shift());
  } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  env.PORT = String(server.address().port);
  const base = `http://127.0.0.1:${env.PORT}`;
  t.after(async () => { server.closeAllConnections(); await new Promise((done) => server.close(done)); });
  const post = async (body, path = '/api/evaluate', headers = {}) => {
    const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { calls, post, base };
}

test('Responses explains; Decisions supplies the displayed probability distribution', async (t) => {
  const { calls, post } = await app(t, [advice(), decision()]);
  const result = await post(state());
  assert.equal(result.status, 200);
  assert.equal(result.body.ready, true);
  assert.deepEqual(result.body.options.map((o) => o.share), [50, 30, 20]);
  assert.deepEqual(calls.map((c) => [c.url, c.body.model]), [
    ['https://api.openai.com/v1/responses', 'gpt-6-luna'], ['https://api.openai.com/v1/decisions', 'gpt-6-luna'],
  ]);
  assert.equal(calls[0].body.store, false);
  assert.equal(calls[0].body.text.format.strict, true);
  assert.equal(calls[0].headers.Authorization, 'Bearer test-secret');
  assert.deepEqual(calls[1].body.questions.map((q) => q.type), ['predicate', 'choice']);
  assert.deepEqual(calls[1].body.questions[1].choices, options.map((o) => ({ value: o.id, description: o.label })));
});

test('empty context does not call a paid API, even without a key', async (t) => {
  const { calls, post } = await app(t, [], { OPENAI_API_KEY: '' });
  const result = await post(state({ context: '   ' }));
  assert.equal(result.status, 200);
  assert.equal(result.body.ready, false);
  assert.ok(result.body.options.every((o) => o.share === null));
  assert.equal(calls.length, 0);
});

test('user and model exclusions remove options from the decision input', async (t) => {
  const { calls, post } = await app(t, [advice(['o1']), decision([1])]);
  const result = await post(state({ options: options.map((o) => ({ ...o, excluded: o.id === 'o2' })) }));
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.options.map((o) => o.share), [100, null, null]);
  assert.deepEqual(JSON.parse(calls[1].body.input).options.map((o) => o.id), ['o0']);
  assert.deepEqual(calls[1].body.questions.map((q) => q.type), ['predicate']);
  assert.equal(result.body.options[2].reason, 'Исключён вами');
});

test('an excluded option is absent from a multi-option choice', async (t) => {
  const { calls, post } = await app(t, [advice(['o1']), decision([0.4, 0, 0.6])]);
  const result = await post(state());
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.options.map((o) => o.share), [40, null, 60]);
  assert.deepEqual(calls[1].body.questions[1].choices.map((c) => c.value), ['o0', 'o2']);
});

test('all excluded options require no decision request', async (t) => {
  const { calls, post } = await app(t, [advice(options.map((o) => o.id))]);
  const result = await post(state());
  assert.equal(result.status, 200);
  assert.equal(result.body.ready, false);
  assert.ok(result.body.options.every((o) => o.excluded && o.share === null));
  assert.equal(calls.length, 1);
});

test('largest remainder always distributes exactly 100 points', () => {
  assert.deepEqual(shares([1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(shares([1, 1, 1, 1, 1, 1]), [17, 17, 17, 17, 16, 16]);
  assert.equal(shares([0.325, 0.325, 0.35]).reduce((a, b) => a + b), 100);
});

test('insufficient context never displays invented scores', async (t) => {
  const { post } = await app(t, [advice(), decision([0.5, 0.3, 0.2], 0.59)]);
  const result = await post(state());
  assert.equal(result.status, 200);
  assert.equal(result.body.ready, false);
  assert.ok(result.body.options.every((o) => o.share === null));
});

test('incomplete or refused provider output fails instead of manufacturing scores', async (t) => {
  for (const replies of [
    [{ ...advice(), status: 'incomplete' }],
    [{ status: 'completed', output: [{ content: [{ type: 'refusal', refusal: 'No' }] }] }],
    [advice(), { answers: [] }],
    [advice(), { answers: [{ name: 'enough_context', type: 'refusal' }] }],
    [advice(), decision([0.7])],
    [advice(), decision([-0.1, 0.5, 0.6])],
    [advice(), decision([0.5, 0.3, 0.2], 2)],
  ]) {
    const { post } = await app(t, replies);
    const result = await post(state());
    assert.equal(result.status, 502);
    assert.deepEqual(Object.keys(result.body), ['error']);
  }
});

test('invalid input is rejected before any provider call', async (t) => {
  const { calls, post, base } = await app(t);
  for (const body of [null, {}, state({ options: [null, options[0]] }), state({ options: [options[0], options[0]] }),
    state({ options: [{ id: 'x', label: 'Поезд' }, { id: 'y', label: ' поезд ' }] }), state({ context: 42 })]) {
    assert.equal((await post(body)).status, 400);
  }
  assert.equal((await post(state({ context: 'x'.repeat(100000) }))).status, 413);
  const malformed = await fetch(`${base}/api/evaluate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400);
  assert.equal((await post(state(), '/api/evaluate', { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal(calls.length, 0);
});

test('local origin checks and the static allowlist protect the API key', async (t) => {
  const { calls, post, base } = await app(t);
  const hostileHost = await new Promise((done, reject) => {
    const req = request(`${base}/api/health`, { headers: { Host: 'attacker.invalid' } }, (res) => { res.resume(); done(res.statusCode); });
    req.on('error', reject).end();
  });
  assert.equal(hostileHost, 403);
  assert.equal((await post(state(), '/api/evaluate', { Origin: 'https://attacker.invalid' })).status, 403);
  for (const path of ['/.env', '/server.js', '/package.json', '/%2e%2e/.env']) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 404);
    assert.ok(!(await response.text()).includes('test-secret'));
  }
  const health = await fetch(`${base}/api/health`);
  assert.deepEqual(await health.json(), { configured: true });
  assert.equal(calls.length, 0);
});
