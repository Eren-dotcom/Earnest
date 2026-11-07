/**
 * Earnest dashboard.
 *
 * Rendering rules that matter for accessibility:
 *  - every status has a text label plus a glyph, never colour alone;
 *  - results are announced through a polite live region, errors assertively;
 *  - state is re-rendered from the API, never optimistically assumed;
 *  - destructive-looking actions are described in plain language first.
 */

const state = {
  data: null,
  contract: null,
  scenario: 'safe-success',
  draft: null,
  busy: false,
};

const STATUS_LABEL = {
  pass: 'Pass',
  fail: 'Fail',
  unclear: 'Unclear',
  waiting: 'Waiting for you',
};

const $ = (id) => document.getElementById(id);

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function announce(message) {
  const region = $('live-region');
  region.textContent = '';
  // A short delay makes repeated identical messages get announced again.
  window.setTimeout(() => {
    region.textContent = message;
  }, 60);
}

function alertUser(message) {
  $('alert-region').textContent = message;
}

function statusTag(status) {
  return el('span', {
    class: `status-tag status-tag--${status}`,
    text: STATUS_LABEL[status] ?? status,
  });
}

function statusTagSmall(status) {
  const tag = statusTag(status);
  tag.classList.add('status-tag--small');
  return tag;
}

function relativeTime(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function clockTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/* ------------------------------------------------------------------ api */

async function api(path, body) {
  const options = body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : { method: 'GET' };

  const response = await fetch(path, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error ?? `Request failed (${response.status})`);
    error.code = payload.code;
    throw error;
  }
  return payload;
}

async function withBusy(button, work) {
  if (state.busy) return;
  state.busy = true;
  const buttons = [...document.querySelectorAll('button')];
  buttons.forEach((b) => {
    b.disabled = true;
  });
  const label = button?.textContent;
  if (button) button.textContent = 'Working…';
  try {
    await work();
  } catch (error) {
    if (error.code === 'repair-required') {
      alertUser('Repair-only mode is active. Repair or restore the open incident before starting new work.');
    } else {
      alertUser(error.message);
    }
  } finally {
    state.busy = false;
    buttons.forEach((b) => {
      b.disabled = false;
    });
    if (button && label) button.textContent = label;
    render();
  }
}

/* ------------------------------------------------------------ rendering */

function renderTrust(data) {
  $('trust-number').textContent = String(data.trust);
  $('trust-fill').style.width = `${data.trust * 10}%`;
  $('trust-meter').setAttribute(
    'aria-label',
    `Project trust level ${data.trust} out of 10: ${data.tier.label}`,
  );

  const pill = $('tier-pill');
  pill.textContent = data.tier.label;
  pill.className = `pill${data.repairOnly ? ' pill--repair' : ''}`;
  $('tier-description').textContent = data.tier.description;

  const tiers = [
    { range: '8–10', label: 'Wider approved scope', mode: 'wider-approved' },
    { range: '5–7', label: 'Limited scope, preview first', mode: 'limited' },
    { range: '1–4', label: 'One change at a time', mode: 'one-at-a-time' },
    { range: '0', label: 'Repair-only', mode: 'repair-only' },
  ];

  const list = $('tier-list');
  clear(list);
  for (const tier of tiers) {
    const current = tier.mode === data.tier.mode;
    const item = el('li', { 'aria-current': current ? 'true' : null }, [
      el('span', { class: 'tier-range', text: tier.range }),
      el('span', { text: tier.label }),
    ]);
    if (current) item.prepend(el('span', { class: 'visually-hidden', text: 'Current tier: ' }));
    list.append(item);
  }

  const next = $('next-privilege');
  clear(next);
  next.append(
    el('strong', { text: data.nextPrivilege.earned ? data.nextPrivilege.label : `Next earned privilege: ${data.nextPrivilege.label}` }),
    el('span', { text: data.nextPrivilege.detail }),
  );
}

function renderProject(data) {
  $('project-score').textContent = data.projectScore === null ? '—' : `${data.projectScore}/10`;
  $('project-score-note').textContent =
    data.projectScore === null
      ? 'No completed task yet. A simple average is used for this prototype, not a weighted one.'
      : `Simple average of ${data.taskCount} completed task${data.taskCount === 1 ? '' : 's'}. A high average never hides a separate safety flag.`;

  const badges = $('badges');
  clear(badges);
  const known = [
    { id: 'verified-work', label: 'verified work' },
    { id: 'clean-repair', label: 'clean repair' },
  ];
  for (const badge of known) {
    if (data.badges.includes(badge.id)) badges.append(el('li', { text: badge.label }));
  }
}

function renderContract(data) {
  const contract = state.contract ?? data.latestTask?.contract ?? {};
  const list = $('contract');
  clear(list);

  const row = (term, value) => {
    const wrap = el('div', {}, [el('dt', { text: term }), el('dd', {})]);
    const dd = wrap.querySelector('dd');
    if (typeof value === 'string') dd.textContent = value;
    else dd.append(value);
    return wrap;
  };

  list.append(
    row('Goal', contract.goal ?? 'Not set'),
    row(
      'Approved files',
      el(
        'span',
        { class: 'chip-row' },
        (contract.allowedPaths ?? []).map((p) => el('span', { class: 'chip', text: p })),
      ),
    ),
    row('Allowed command', el('span', { class: 'chip', text: contract.projectTestCommand ?? 'node --test' })),
    row(
      'Invariants',
      el(
        'ul',
        { class: 'plain-list small' },
        (contract.invariants ?? []).map((i) => el('li', { text: i })),
      ),
    ),
    row('Risk level', `${contract.riskLevel ?? 'low'} (${contract.reversible ? 'reversible' : 'not reversible'})`),
    row(
      'Verification plan',
      el('ul', { class: 'plain-list small' }, (contract.verificationPlan ?? []).map((v) => el('li', { text: v }))),
    ),
  );

  if (!state.draft) {
    state.draft = {
      goal: contract.goal ?? '',
      paths: (contract.allowedPaths ?? []).join('\n'),
      invariants: (contract.invariants ?? []).join('\n'),
    };
    $('goal-input').value = state.draft.goal;
    $('paths-input').value = state.draft.paths;
    $('invariants-input').value = state.draft.invariants;
  }
}

function renderScenarios(data) {
  const list = $('scenario-list');
  clear(list);
  for (const scenario of data.scenarios) {
    const id = `scenario-${scenario.id}`;
    const input = el('input', {
      type: 'radio',
      name: 'scenario',
      id,
      value: scenario.id,
      checked: state.scenario === scenario.id,
      onchange: () => {
        state.scenario = scenario.id;
        render();
      },
    });

    const label = el('label', { class: 'scenario', for: id }, [
      input,
      el('span', {}, [
        el('span', { class: 'scenario__name', text: scenario.name }),
        el('span', { class: 'scenario__tagline', text: scenario.tagline }),
        el('span', { class: 'scenario__desc', text: scenario.description }),
      ]),
    ]);
    list.append(label);
  }
}

function renderRunControls(data) {
  const runBtn = $('run-btn');
  const scenario = data.scenarios.find((s) => s.id === state.scenario);
  runBtn.textContent = `Run: ${scenario?.name ?? 'task'}`;
  runBtn.disabled = state.busy || data.repairOnly;

  const hint = $('run-hint');
  if (data.repairOnly) {
    hint.textContent =
      'Repair-only mode is active. Earnest will not start a new task until the open incident is repaired or the checkpoint is restored.';
  } else if (data.activeTask) {
    hint.textContent = 'A task is waiting for your review. Complete it before starting another.';
  } else {
    hint.textContent =
      'Earnest enforces the contract at the filesystem boundary, then scores what actually happened.';
  }
  runBtn.disabled = state.busy || data.repairOnly || Boolean(data.activeTask);
}

function renderIncident(data) {
  const banner = $('incident-banner');
  if (!data.incident || data.incident.status === 'resolved') {
    banner.hidden = true;
    return;
  }

  banner.hidden = false;
  $('incident-title').textContent =
    data.incident.severity === 'critical' ? 'Stopped: protected path targeted' : 'Repair-only mode';

  $('incident-summary').textContent = `${data.incident.summary} New tasks are paused until this is resolved.`;

  const list = $('incident-detail');
  clear(list);
  for (const line of data.incident.detail ?? []) {
    list.append(el('li', { text: line }));
  }

  const restoreBtn = $('restore-btn');
  restoreBtn.textContent = data.incident.blocked
    ? 'Restore checkpoint (nothing was changed)'
    : 'Restore checkpoint';
}

function checkItem(check) {
  const item = el('li', { class: 'check-item' }, [
    el('div', { class: 'check-item__head' }, [
      el('span', { class: 'check-item__label', text: check.label }),
      statusTag(check.status),
    ]),
    el('p', { class: 'check-item__summary', text: check.summary }),
  ]);

  if (check.subchecks?.length) {
    const sub = el('ul', { class: 'subcheck-list' });
    for (const entry of check.subchecks) {
      sub.append(
        el('li', {}, [
          statusTagSmall(entry.status),
          el('span', {}, [el('span', { text: `${entry.label}. ` }), el('span', { text: entry.note ?? '' })]),
        ]),
      );
    }
    item.append(sub);
  } else if (check.detail?.length) {
    const detail = el('ul', { class: 'check-item__detail' });
    for (const line of check.detail) detail.append(el('li', { text: line }));
    item.append(detail);
  }

  if (check.limitation) {
    item.append(el('p', { class: 'check-item__limit', text: `Limitation: ${check.limitation}` }));
  }

  return item;
}

function renderTask(data) {
  const task = data.activeTask ?? data.latestTask;
  const statusEl = $('task-status');
  const scoreEl = $('task-score');
  const tagEl = $('task-score-tag');
  const summaryEl = $('task-summary');
  const checkList = $('check-list');

  clear(checkList);

  if (!task) {
    statusEl.textContent = 'No task has run yet';
    scoreEl.textContent = '—';
    tagEl.textContent = '';
    summaryEl.textContent = 'Choose a scenario and run a task to see how Earnest verifies the work.';
    $('review-block').hidden = true;
    checkList.append(el('li', { class: 'empty', text: 'No checks have run yet.' }));
    return;
  }

  const awaiting = task.status === 'awaiting-review';
  statusEl.textContent = awaiting
    ? 'Awaiting your review'
    : task.status === 'complete'
      ? 'Complete'
      : task.status;

  scoreEl.textContent = `${task.score}/10`;
  tagEl.textContent = task.provisional
    ? 'Provisional — needs your review'
    : task.outcome === 'pass'
      ? 'Final · verified pass'
      : task.outcome === 'fail'
        ? 'Final · failed'
        : 'Final · unclear';

  const parts = [];
  if (task.checks) {
    parts.push(task.checks.goal.summary);
    if (task.checks.scope.violations?.length) parts.push(task.checks.scope.summary);
    if (task.checks.tests.status === 'fail') parts.push(task.checks.tests.summary);
    if (task.checks.honesty.status === 'fail') parts.push(task.checks.honesty.summary);
  }
  summaryEl.textContent = parts.join(' ');

  if (task.checks) {
    const order = ['goal', 'scope', 'tests', 'accessibility', 'honesty', 'human'];
    for (const key of order) {
      const check = task.checks[key];
      if (check) checkList.append(checkItem(check));
    }
  }

  $('review-block').hidden = !awaiting;
  if (awaiting) {
    $('review-note').value = '';
  }
}

function renderBreakdown(data) {
  const body = $('breakdown-body');
  clear(body);
  const task = data.activeTask ?? data.latestTask;
  if (!task?.breakdown?.length) {
    body.append(el('tr', {}, [el('td', { colspan: '4', class: 'empty', text: 'No task scored yet.' })]));
    return;
  }

  for (const dim of task.breakdown) {
    const rating =
      dim.rating === null
        ? el('span', { class: 'unrated', text: 'Unrated' })
        : `${dim.rating}/10`;
    body.append(
      el('tr', {}, [
        el('td', { class: 'dim-name', text: dim.label }),
        el('td', { class: 'num', text: `${dim.weight}%` }),
        el('td', { class: 'num' }, [typeof rating === 'string' ? document.createTextNode(rating) : rating]),
        el('td', { class: 'dim-evidence', text: dim.evidence ?? '' }),
      ]),
    );
  }
}

function renderActions(data) {
  const list = $('action-list');
  clear(list);
  const task = data.activeTask ?? data.latestTask;
  if (!task?.actions?.length) {
    list.append(el('li', { class: 'empty', text: 'No actions yet.' }));
    return;
  }

  for (const action of task.actions) {
    const denied = action.decision === 'deny';
    list.append(
      el('li', { class: `action-item${denied ? ' action-item--denied' : ''}` }, [
        el('span', { class: 'action-item__badge', text: denied ? 'BLOCKED' : action.type.toUpperCase() }),
        el('span', {}, [
          el('span', { class: 'action-item__path', text: action.path }),
          el('span', { class: 'action-item__detail', text: ` ${action.detail}` }),
        ]),
      ]),
    );
  }
}

function renderDiffs(data) {
  const list = $('diff-list');
  clear(list);
  const task = data.activeTask ?? data.latestTask;
  if (!task?.diff?.length) {
    list.append(el('p', { class: 'empty', text: 'No changes yet.' }));
    return;
  }

  for (const file of task.diff) {
    const lines = el('ul', { class: 'diff-lines' });
    if (!file.lines.length) {
      lines.append(el('li', { class: 'context', text: 'No line-level changes.' }));
    }
    for (const line of file.lines) {
      lines.append(el('li', { class: line.type, text: line.text || ' ' }));
    }
    const node = el('div', { class: 'diff-file' }, [
      el('div', { class: 'diff-file__head' }, [
        el('span', { text: file.path }),
        el('span', { class: 'diff-file__status', text: file.status }),
      ]),
      lines,
    ]);
    list.append(node);
  }

  const note = el('p', {
    class: 'diff-note',
    text: 'Diff read from the disposable workspace on disk. Blocked edits never reach this list.',
  });
  list.append(note);
}

function renderLedger(data) {
  const trustList = $('trust-history');
  clear(trustList);
  if (!data.trustHistory.length) {
    trustList.append(el('li', { class: 'empty', text: 'No changes yet.' }));
  } else {
    for (const entry of data.trustHistory) {
      const delta = entry.to - entry.from;
      const direction = delta === 0 ? 'held' : delta > 0 ? `+${delta}` : String(delta);
      trustList.append(
        el('li', { class: `ledger-item ledger-item--${delta > 0 ? 'success' : delta < 0 ? 'warning' : 'info'}` }, [
          el('p', { class: 'ledger-item__text' }, [
            el('strong', { text: `Trust ${entry.from} → ${entry.to} (${direction}). ` }),
            document.createTextNode(entry.reason),
          ]),
          el('p', { class: 'ledger-item__meta', text: `${clockTime(entry.at)} · ${relativeTime(entry.at)}` }),
        ]),
      );
    }
  }

  const eventList = $('event-list');
  clear(eventList);
  if (!data.ledger.length) {
    eventList.append(el('li', { class: 'empty', text: 'No events yet.' }));
  } else {
    for (const entry of data.ledger) {
      eventList.append(
        el('li', { class: `ledger-item ledger-item--${entry.severity ?? 'info'}` }, [
          el('p', { class: 'ledger-item__text', text: entry.text }),
          el('p', { class: 'ledger-item__meta', text: `${clockTime(entry.at)} · ${entry.type.replace(/-/g, ' ')}` }),
        ]),
      );
    }
  }
}

function render() {
  const data = state.data;
  if (!data) return;
  renderTrust(data);
  renderProject(data);
  renderContract(data);
  renderScenarios(data);
  renderRunControls(data);
  renderIncident(data);
  renderTask(data);
  renderBreakdown(data);
  renderActions(data);
  renderDiffs(data);
  renderLedger(data);
}

/* --------------------------------------------------------------- events */

$('run-btn').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const contract = state.contract ?? {};
  await withBusy(button, async () => {
    const payload = await api('/api/run', {
      scenarioId: state.scenario,
      contract: {
        goal: $('goal-input').value.trim() || contract.goal,
        allowedPaths: $('paths-input')
          .value.split('\n')
          .map((l) => l.trim())
          .filter(Boolean),
        invariants: $('invariants-input')
          .value.split('\n')
          .map((l) => l.trim())
          .filter(Boolean),
        allowedCommands: contract.allowedCommands,
        acceptanceChecks: contract.acceptanceChecks,
        projectTestCommand: contract.projectTestCommand,
        riskLevel: contract.riskLevel,
        reversible: contract.reversible,
        verificationPlan: contract.verificationPlan,
        allowDelete: false,
      },
    });
    state.data = payload;
    const task = payload.activeTask;
    const blocked = task.actions.filter((a) => a.decision === 'deny').length;
    announce(
      `Task finished. Provisional score ${task.score} out of 10. ` +
        `${blocked} action${blocked === 1 ? '' : 's'} blocked by policy. Review the result to make the score final.`,
    );
  });
});

$('accept-btn').addEventListener('click', async (event) => {
  const note = $('review-note').value.trim();
  await withBusy(event.currentTarget, async () => {
    state.data = await api('/api/review', { verdict: 'accept', note });
    const task = state.data.latestTask;
    announce(
      `Result accepted. Final score ${task.score} out of 10. Trust is now ${state.data.trust} out of 10. ${task.trustReason ?? ''}`,
    );
  });
});

$('reject-btn').addEventListener('click', async (event) => {
  const note = $('review-note').value.trim();
  await withBusy(event.currentTarget, async () => {
    state.data = await api('/api/review', { verdict: 'reject', note });
    const task = state.data.latestTask;
    announce(`Result rejected. Final score ${task.score} out of 10. Trust is now ${state.data.trust} out of 10.`);
  });
});

$('repair-btn').addEventListener('click', async (event) => {
  await withBusy(event.currentTarget, async () => {
    state.data = await api('/api/repair', {});
    const resolved = state.data.incident?.status === 'resolved';
    announce(
      resolved
        ? `Repair verified. The out-of-scope change was reverted. Trust is now ${state.data.trust} out of 10 and new tasks are allowed.`
        : 'The repair did not clear the violation, so the incident stays open.',
    );
  });
});

$('restore-btn').addEventListener('click', async (event) => {
  await withBusy(event.currentTarget, async () => {
    const payload = await api('/api/restore', { checkpointId: state.data.latestTask?.checkpointId });
    state.data = payload.state;
    announce(
      payload.restore.ok
        ? 'Checkpoint restored and verified by content hash. The workspace matches the snapshot taken before the task.'
        : 'Restore could not be verified, so the workspace state cannot be trusted.',
    );
  });
});

$('reset-btn').addEventListener('click', async (event) => {
  await withBusy(event.currentTarget, async () => {
    state.data = await api('/api/reset', {});
    state.draft = null;
    announce('Demo reset. The workspace is a fresh copy of the sample project and trust is back to 5 out of 10.');
  });
});

$('contract-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  state.contract = {
    ...state.contract,
    goal: $('goal-input').value.trim(),
    allowedPaths: $('paths-input')
      .value.split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
    invariants: $('invariants-input')
      .value.split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
  };
  render();
  announce('Contract saved. The next task will be judged against these terms.');
});

/* ----------------------------------------------------------------- boot */

async function boot() {
  try {
    const payload = await api('/api/scenarios');
    state.contract = payload.contract;
    state.data = await api('/api/state');
    state.scenario = state.data.scenarios[0]?.id ?? 'safe-success';
    render();
    announce('Earnest loaded. Choose a scenario to run a simulated agent task.');
  } catch (error) {
    alertUser(`Earnest could not load: ${error.message}`);
    $('task-summary').textContent = `Earnest could not reach its server. ${error.message}`;
  }
}

boot();
