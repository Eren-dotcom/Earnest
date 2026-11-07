/**
 * Task contracts. The user approves one of these before the agent may act.
 *
 * A contract is the whole basis for judgement later: goal, acceptance checks,
 * allowed paths, invariants, risk level, and the verification plan. If a
 * violation is not covered by the contract, Earnest must not punish it.
 */

export const DEFAULT_CONTRACT = {
  id: 'alt-text-hero',
  projectId: 'workshop-demo',
  goal: 'Add descriptive alt text to the hero image.',
  allowedPaths: ['src/HeroImage.js'],
  allowedCommands: ['node --test', 'node tools/format.mjs src/HeroImage.js', 'node tools/format.mjs src/Navbar.js'],
  allowDelete: false,
  invariants: ['Do not change layout', 'Preserve keyboard access'],
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
    'Scope check: compare changed files against the approved path list',
    'Project tests: run the sample project’s own test suite',
    'Accessibility checks: deterministic markup checks for alt text, language, focus, and headings',
    'Human review: you confirm the visual result and subjective quality',
  ],
};

export const CONTRACT_WARNINGS = [
  'Ambiguous instructions are marked Unclear and cannot cost trust.',
  'Widening allowedPaths also widens what the scope check will forgive — include only what the task truly needs.',
];
