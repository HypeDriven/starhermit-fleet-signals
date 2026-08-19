/**
 * Learn mode: interactive lessons. Each lesson runs a real engine match
 * (same legal-action API as play) and waits for the player to perform the
 * required action — reading alone never completes a step.
 */

export const LESSONS = [
  {
    id: 'deploy',
    title: 'Lesson 1 — Deploy the fleet',
    intro: 'Every engagement opens with a secret deployment. Place all three ships on your chart. Ships cannot overlap or hang off the edge.',
    config: {
      seed: 'learn-deploy', gridSize: 6, fleetId: 'patrol', mechanics: {},
      players: [
        { id: 'you', name: 'You' },
        { id: 'ai', name: 'Instructor', isAI: true, difficulty: 'easy' },
      ],
    },
    steps: [
      { waitFor: 'place-all', text: 'Select a ship from the tray, then tap a cell to place its bow. Use Rotate (or R) to change direction. Repeat until every ship is deployed, then press Confirm Deployment.' },
    ],
  },
  {
    id: 'first-shot',
    title: 'Lesson 2 — Call your first shot',
    intro: 'The instructor has deployed. Pick any coordinate on the target chart and fire.',
    config: {
      seed: 'learn-first-shot', gridSize: 6, fleetId: 'patrol', mechanics: {},
      players: [
        { id: 'you', name: 'You' },
        { id: 'ai', name: 'Instructor', isAI: true, difficulty: 'easy' },
      ],
    },
    skipPlacement: true, // player's fleet is auto-placed
    steps: [
      { waitFor: 'fire', text: 'Tap a coordinate on the large target chart to select it, then tap again or press Fire (Enter). Watch the result marker.' },
    ],
  },
  {
    id: 'read-results',
    title: 'Lesson 3 — Read the water',
    intro: 'A white ring means open water. An orange spear means hull contact. Keep firing until you score a hit.',
    config: {
      seed: 'learn-read', gridSize: 6, fleetId: 'patrol', mechanics: {},
      players: [
        { id: 'you', name: 'You' },
        { id: 'ai', name: 'Instructor', isAI: true, difficulty: 'easy' },
      ],
    },
    skipPlacement: true,
    steps: [
      { waitFor: 'hit', text: 'Fire at coordinates until you land a HIT. Hits stay marked — a damaged ship still floats until every cell is struck.' },
    ],
  },
  {
    id: 'deductions',
    title: 'Lesson 4 — Mark your deductions',
    intro: 'Captains annotate the chart. Flag a cell you suspect holds a ship, or mark one as unknown. Notes are private and never end your turn.',
    config: {
      seed: 'learn-notes', gridSize: 6, fleetId: 'patrol', mechanics: {},
      players: [
        { id: 'you', name: 'You' },
        { id: 'ai', name: 'Instructor', isAI: true, difficulty: 'easy' },
      ],
    },
    skipPlacement: true,
    steps: [
      { waitFor: 'annotate', text: 'Toggle Note mode (N), then tap any cell to flag it. Toggle again to switch between flag and question marks; tap a marked cell to clear it.' },
    ],
  },
  {
    id: 'sink-fleet',
    title: 'Lesson 5 — Finish the engagement',
    intro: 'Sink the entire instructor fleet before yours falls. Hints are enabled if you want a suggestion.',
    config: {
      seed: 'learn-final', gridSize: 6, fleetId: 'patrol', mechanics: {},
      players: [
        { id: 'you', name: 'You' },
        { id: 'ai', name: 'Instructor', isAI: true, difficulty: 'easy' },
      ],
    },
    skipPlacement: true,
    steps: [
      { waitFor: 'finish', text: 'Use hit markers to trace each ship and sink all three. Good hunting, Captain.' },
    ],
  },
];

export function lessonById(id) {
  return LESSONS.find((l) => l.id === id);
}
