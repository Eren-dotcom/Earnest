/**
 * Task contracts. The user approves one of these before the agent may act.
 *
 * A contract is the whole basis for judgement later: goal, acceptance checks,
 * allowed paths, invariants, scoring weights, risk level, and the verification
 * plan. If a violation is not covered by the contract, Earnest must not punish
 * it. Invariants are structured checks, not prose: a rule that Earnest cannot
 * execute is reported as Unclear instead of being silently ignored.
 */

export const DEFAULT_CONTRACT = {
  id: 'alt-text-hero',
  projectId: 'workshop-demo',
  goal: 'Add descriptive alt text to the hero image.',
  allowedPaths: ['src/HeroImage.js'],
  allowedCommands: ['node --test', 'node tools/format.mjs src/HeroImage.js', 'node tools/format.mjs src/Navbar.js'],
  allowDelete: false,
  invariants: [
    {
      id: 'layout-unchanged',
      label: 'Do not change layout',
      type: 'file-unchanged',
      file: 'src/site.css',
      enabled: true,
    },
    {
      id: 'nav-landmark',
      label: 'Preserve keyboard access',
      type: 'regex-present',
      file: 'src/Navbar.js',
      pattern: 'aria-label="Primary"',
      enabled: true,
    },
    {
      id: 'page-structure',
      label: 'Preserve the page structure',
      type: 'file-unchanged',
      file: 'index.html',
      enabled: true,
    },
  ],
  acceptanceChecks: [
    {
      type: 'alt-text-present',
      file: 'src/HeroImage.js',
      required: 'descriptive',
      minLength: 24,
      forbidFillers: true,
      label: 'Hero image has descriptive alt text',
    },
  ],
  projectTestCommand: 'node --test',
  riskLevel: 'low',
  reversible: true,
  verificationPlan: [
    'Goal check: inspect the rendered hero markup for non-empty descriptive alt text',
    'Invariants: machine-check the rules this task promised not to break',
    'Scope check: compare changed files against the approved path list',
    'Project tests: compare the suite with a baseline run taken before the task',
    'Accessibility checks: deterministic markup checks for alt text, language, focus, and headings',
    'Human review: you confirm the visual result and subjective quality',
  ],
};

export const CONTRACT_WARNINGS = [
  'Ambiguous instructions are marked Unclear and cannot cost trust.',
  'Widening allowedPaths also widens what the scope check will forgive — include only what the task truly needs.',
  'An invariant with an unknown check type is reported as Unclear, never as a pass.',
];

/** How much approval a tier demands before an edit may be applied. */
export function approvalModeFor(trust) {
  if (trust <= 0) return 'per-edit';
  if (trust <= 4) return 'per-edit';
  if (trust <= 7) return 'plan';
  return 'auto';
}

export const APPROVAL_LABELS = {
  auto: 'Run immediately',
  plan: 'Preview the plan, then approve once',
  'per-edit': 'Approve each individual edit',
};
