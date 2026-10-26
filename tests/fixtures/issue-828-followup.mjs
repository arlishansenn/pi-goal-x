import assert from 'node:assert/strict';
import test from 'node:test';
import { extensionFixture, producers, OWNER, GOAL_ID } from './issue-828-extension.mjs';
import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseGoalFile } from '../../extensions/storage/goal-files.ts';
import { observeHostMessage } from '../../extensions/goal-background-registry.ts';
import { acquireGoalLock } from '../../extensions/storage/goal-lock.ts';

for (const namespace of ['structured:bg_run', 'structured:bg_status']) {
  test(`R1: canonical parser migrates ${namespace} and preserves receipt scope and budget`, async () => {
    const h = await extensionFixture();
    try {
      await h.begin();
      await h.result(producers.background.launch('legacy-bg'));
      await h.result(producers.subagent.launch('subagent-sibling'));
      await h.settle();
      const goal = await h.goal();
      const file = path.resolve(h.cwd, goal.activePath);
      const before = parseGoalFile(file).scheduler.backgroundTasks;
      assert.ok(before.tasks[0] && !before.tasks[0].hostReported, 'precondition: canonical task is tracked');
      const raw = readFileSync(file, 'utf8');
      assert.ok(raw.includes('ismailsaleekh/pi-background-tasks'));
      writeFileSync(file, raw.replaceAll('ismailsaleekh/pi-background-tasks', namespace));
      const parsed = parseGoalFile(file);
      assert.equal(parsed.scheduler.backgroundTasks.tasks[0].producer, 'ismailsaleekh/pi-background-tasks');
      assert.deepEqual(parsed.scheduler.backgroundTasks, before, 'only the verified namespace migrates; scope, receipt, subagent identity and budgets survive');
      const report = observeHostMessage(parsed.scheduler.backgroundTasks, { role: 'custom', customType: 'background-task-notification', details: { id: 'legacy-bg', status: 'completed' } });
      assert.equal(report.state.tasks[0].hostReported, true, 'native report matches the parsed canonical identity');
      assert.deepEqual(report.state.tasks[1], before.tasks[1], 'native report does not consume the subagent sibling');
    } finally { await h.close(); }
  });
}

const B = 'followup-session-b';
const tasks = goal => goal.scheduler?.backgroundTasks?.tasks ?? [];

async function takeover(run) {
  const a = await extensionFixture();
  let b;
  try {
    await a.begin();
    await a.result(producers.subagent.launch('survivor'));
    await a.settle();
    const before = await a.goal();
    assert.ok(tasks(before)[0] && !tasks(before)[0].hostReported, 'precondition: old task is tracked and outstanding');
    assert.equal(tasks(before)[0].wait, undefined, 'precondition: issue 10 leaves no system wait budget on tasks');
    b = await extensionFixture({ cwd: a.cwd, owner: B });
    await b.command('goal-resume');
    const resumed = await b.goal();
    assert.equal(resumed.scheduler.owner, B, 'precondition: explicit resume acquired scheduling ownership');
    await run({ a, b, before, resumed });
  } finally {
    if (b) await b.close();
    await a.close();
  }
}

test('F1: explicit cross-owner resume preserves old task identity and spent budget', async () => {
  await takeover(async ({ before, resumed }) => {
    assert.deepEqual(tasks(resumed), tasks(before), 'resume must not renew task budget or relabel old producer evidence');
    assert.equal(resumed.scheduler.backgroundTasks.scope.sessionId, OWNER, 'old initiation provenance must not become B');
  });
});

test('F1: resumed scheduler can enroll a legitimate B launch without rewriting A evidence', async () => {
  await takeover(async ({ b, before }) => {
    await b.begin();
    const launch = producers.subagent.launch('b-new-task', 'b-call');
    await b.event('tool_call', { toolCallId: 'b-call', toolName: 'subagent', input: launch.input });
    await b.result(launch);
    const after = await b.goal();
    assert.ok(tasks(after).some(task => task.taskId === 'b-new-task'), 'explicit resume must permit new-owner launches');
    assert.deepEqual(tasks(after).find(task => task.taskId === 'survivor'), tasks(before)[0], 'old receipt, identity and wait budget survive new launches');
    assert.ok(!b.notifications.some(text => /Background task scope changed|scheduling stopped/i.test(text)), 'legitimate launch must not latch a storage failure');
  });
});

test('F1: resumed owner still gates an old task poll without a task-check grant', async () => {
  await takeover(async ({ b }) => {
    await b.begin();
    const [toolName, input] = producers.subagent.poll('survivor');
    const gate = await b.event('tool_call', { toolCallId: 'b-ungranted-poll', toolName, input });
    assert.equal(gate?.block, true, 'preserved old budget must remain visible to admission checks after resume');
  });
});

for (const source of [undefined, OWNER, B]) {
  test(`F1 safety: scheduler ownership alone does not authorize old receipt delivery (reported session ${source})`, async () => {
    await takeover(async ({ b }) => {
      await b.begin();
      const report = producers.subagent.host('survivor');
      if (source !== undefined) {
        report.details.sessionId = source;
        report.details.runs[0].sessionId = source;
      }
      await b.message(report);
      const after = await b.goal();
      assert.equal(tasks(after).find(task => task.taskId === 'survivor').hostReported, false, 'no explicit producer delivery-transfer authorization was supplied');
      assert.equal(tasks(after).find(task => task.taskId === 'survivor').wait, undefined, 'no wait budget exists to transfer');
    });
  });
}

test('F2: a call observed with no focused goal cannot enroll its late result in a new goal', async () => {
  const h = await extensionFixture();
  try {
    await h.command('goal-unfocus');
    assert.equal(await h.goal(), null);
    await h.begin();
    const launch = producers.subagent.launch('unowned-task', 'observed-unowned');
    await h.event('tool_call', { toolCallId: launch.toolCallId, toolName: launch.toolName, input: launch.input });
    await h.tool('create_goal', { objective: 'New unrelated goal' });
    const created = await h.goal();
    assert.notEqual(created.id, GOAL_ID, 'precondition: new goal was created');
    await h.result(launch);
    const after = await h.goal();
    assert.equal(tasks(after).some(task => task.taskId === 'unowned-task'), false, 'observed no-goal origin is not missing metadata and must not fall through');
  } finally { await h.close(); }
});

function assertRejectedTool(result) {
  const text = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
  assert.notEqual(result.terminate, true, 'failed replacement must not terminate as successful completion');
  assert.doesNotMatch(text, /Goal confirmed and created|Goal created|confirmed and started/i, 'failed replacement must not claim success');
  assert.match(text, /not (?:saved|created)|stopped|failed|unable|could not|blocked|buffer|lock/i, 'tool must explain non-success');
}

async function dirtyLocked(h, run) {
  await h.begin();
  await h.result(producers.subagent.launch('dirty-busy'));
  const lock = acquireGoalLock(h.ctx, GOAL_ID);
  try { await run(); } finally { lock.release(); }
}

test('F5 create_goal: flush rejection is surfaced, not reported as created or terminate', async () => {
  const h = await extensionFixture();
  try {
    await dirtyLocked(h, async () => {
      const result = await h.tool('create_goal', { objective: 'Must not claim this was created' });
      assert.equal((await h.goal()).id, GOAL_ID, 'rejected transition leaves old focus intact');
      assert.ok(h.notifications.some(text => /Goal transition stopped/.test(text)), 'precondition: replaceGoal flush actually rejected');
      assertRejectedTool(result);
    });
  } finally { await h.close(); }
});

for (const [command, objective] of [
  ['goal-direct', 'Do not claim direct goal creation succeeded'],
  ['sisyphus-direct', '1) Read the source; done when inspected. 2) Run tests; done when all pass.'],
]) {
  test(`F5 /${command}: rejected replacement warns without success notification or focus change`, async () => {
    const h = await extensionFixture();
    try {
      await dirtyLocked(h, async () => {
        const start = h.notifications.length;
        await h.command(command, objective);
        const messages = h.notifications.slice(start);
        assert.equal((await h.goal()).id, GOAL_ID);
        assert.ok(messages.some(text => /Goal transition stopped/.test(text)), 'flush rejection is visible to command user');
        assert.ok(!messages.some(text => /Goal (?:confirmed|created|running)|Sisyphus (?:goal )?(?:created|running)/i.test(text)), 'no success notification');
      });
    } finally { await h.close(); }
  });
}

test('F5 draft: post-confirmation flush rejection keeps draft retryable and does not claim creation', async () => {
  const saved = process.env.PI_GOAL_AUTO_CONFIRM;
  delete process.env.PI_GOAL_AUTO_CONFIRM;
  const h = await extensionFixture({ hasUI: true });
  let lock;
  try {
    await h.command('goal', 'Draft a new goal');
    assert.ok(h.entries.some(entry => entry.customType === 'pi-goal-draft' && !entry.data.clearedAt), 'precondition: draft active');
    h.ctx.ui.select = async (_title, labels) => {
      if (labels.some(label => label.includes('Confirm —'))) {
        await h.begin();
        await h.result(producers.subagent.launch('confirmation-busy'));
        lock = acquireGoalLock(h.ctx, GOAL_ID);
      }
      return labels[0];
    };
    const result = await h.tool('propose_goal_draft', { objective: 'Confirmed draft must remain retryable on failed flush', sisyphus: false });
    assert.equal((await h.goal()).id, GOAL_ID);
    assert.ok(h.notifications.some(text => /Goal transition stopped/.test(text)), 'precondition: rejection occurs inside replaceGoal, after initial proposal flush');
    const text = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
    assert.deepEqual({
      successfulTermination: result.terminate === true,
      claimsCreated: /Goal confirmed and created|Goal created|confirmed and started/i.test(text),
      draftCleared: !!h.entries.filter(entry => entry.customType === 'pi-goal-draft').at(-1).data.clearedAt,
    }, { successfulTermination: false, claimsCreated: false, draftCleared: false }, 'rejected replacement must neither claim creation nor destroy retryable draft');
    assertRejectedTool(result);
  } finally {
    lock?.release();
    await h.close();
    if (saved === undefined) delete process.env.PI_GOAL_AUTO_CONFIRM; else process.env.PI_GOAL_AUTO_CONFIRM = saved;
  }
});

test('F1: new owner consumes only its new receipt and keeps old deadline after reload', async () => {
  await takeover(async ({ b }) => {
    await b.begin();
    const launch = producers.subagent.launch('b-owned', 'b-owned-call');
    await b.event('tool_call', { toolCallId: 'b-owned-call', toolName: 'subagent', input: launch.input });
    await b.result(launch);
    await b.settle();
    await b.message(producers.subagent.host('b-owned'));
    await b.begin();
    await b.settle();
    const state = (await b.goal()).scheduler.backgroundTasks;
    assert.equal(state.scope.sessionId, OWNER);
    assert.equal(state.tasks.find(task => task.taskId === 'b-owned').scope.sessionId, B);
    assert.equal(state.tasks.find(task => task.taskId === 'b-owned').hostReported, true);
    assert.equal(state.tasks.find(task => task.taskId === 'survivor').hostReported, false);
    assert.equal(state.tasks.find(task => task.taskId === 'survivor').wait, undefined, 'the survivor keeps no system budget');
    const { normalizeBackgroundTasks } = await import('../../extensions/goal-background-registry.ts');
    assert.deepEqual(JSON.parse(JSON.stringify(normalizeBackgroundTasks(state))), JSON.parse(JSON.stringify(state)));
    assert.equal((await b.goal()).scheduler.wait.deadline, undefined, 'issue 10: no system deadline survives the reload');
  });
});
