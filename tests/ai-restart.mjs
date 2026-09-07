import assert from 'node:assert/strict';
import { App } from '../src/ui/app.js';
const app = Object.create(App.prototype);
let oldTurns = 0, newTurns = 0;
app.aiDelay = () => 10;
app._renderTray = () => {};
app._afterCommand = () => {};
app.session = { state: { phase: 'battle' }, needsAI: () => true, stepAI: () => { oldTurns++; return { events: [] }; } };
app._pumpAI();
app.sessionTeardown();
app.session = { state: { phase: 'battle' }, needsAI: () => true, stepAI: () => { newTurns++; return { events: [] }; } };
app._pumpAI();
app._pumpAI(); // repeated resume must not schedule a duplicate turn
await new Promise(resolve => setTimeout(resolve, 40));
assert.equal(oldTurns, 0);
assert.equal(newTurns, 1, 'a new match gets exactly one AI turn after restart');
app.sessionTeardown();
console.log('AI restart regression passed.');
