'use strict';
// Trusted gameplay RPC. Receives data, never evaluates participant JavaScript.
const fs = require('node:fs');
const http = require('node:http');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const protocol = JSON.parse(fs.readFileSync('/config/protocol.json', 'utf8'));
const bots = new Map(); const busy = new Set(); const chat = [];
const integer = (value, min, max) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw Error('Invalid bounded integer');
  return value;
};
const point = input => new Vec3(integer(input.x, -30000000, 30000000),
  integer(input.y, -64, 320), integer(input.z, -30000000, 30000000));
const bounded = (promise, ms) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Gameplay deadline')), ms); })])
    .finally(() => clearTimeout(timer));
};
function permit(operation, args) {
  const observation = ['position', 'health', 'inventory', 'blocks', 'entities', 'advancements'].includes(operation)
    || operation === 'team-chat' && args.message === undefined;
  if (!(observation ? protocol.observations : protocol.actions).includes(operation)) throw Error('Frozen permission denied');
}
async function invoke(participant, operation, args) {
  if (!bots.has(participant)) throw Error('Unknown participant');
  permit(operation, args);
  if (busy.has(participant)) throw Error('Participant already executing');
  const bot = bots.get(participant); busy.add(participant);
  try {
    switch (operation) {
      case 'position': return { ...bot.entity.position, dimension: bot.game.dimension };
      case 'health': return { health: bot.health, food: bot.food, alive: bot.health > 0 };
      case 'inventory': return bot.inventory.items().map(({ name, count }) => ({ name, count }));
      case 'blocks': {
        const position = point(args);
        if (position.distanceTo(bot.entity.position) > 16) throw Error('Observation out of range');
        const block = bot.blockAt(position); return block ? { name: block.name, position: block.position } : null;
      }
      case 'entities': return Object.values(bot.entities).filter(e => e.position.distanceTo(bot.entity.position) < 32)
        .slice(0, 100).map(e => ({ id: e.id, name: e.name, username: e.username, position: e.position }));
      // Client-visible state is observation only. Host server files are the scoring oracle.
      case 'advancements': return bot._papercuspAdvancements || [];
      case 'team-chat': {
        if (args.message === undefined) return chat.slice(-100);
        if (typeof args.message !== 'string' || args.message.length > 200 || /[\r\n]/.test(args.message)
          || args.message.trimStart().startsWith('/')) throw Error('Administrative chat is forbidden');
        bot.chat(args.message); return null;
      }
      case 'move': {
        const position = point(args);
        if (position.distanceTo(bot.entity.position) > 64) throw Error('Movement out of range');
        try { await bounded(bot.pathfinder.goto(new goals.GoalNear(position.x, position.y, position.z, 1)), protocol.limits.maxProgramMs); }
        finally { bot.pathfinder.stop(); bot.clearControlStates(); }
        return { ...bot.entity.position };
      }
      case 'mine': {
        const position = point(args);
        if (position.distanceTo(bot.entity.position) > 5) throw Error('Mining out of range');
        const block = bot.blockAt(position); if (!block) throw Error('Unloaded block');
        try { await bounded(bot.dig(block), protocol.limits.maxProgramMs); }
        finally { bot.stopDigging(); }
        return null;
      }
      case 'craft': {
        const item = bot.registry.itemsByName[args.item]; if (!item) throw Error('Unknown item');
        const table = bot.findBlock({ matching: bot.registry.blocksByName.crafting_table.id, maxDistance: 4 });
        const recipe = bot.recipesFor(item.id, null, 1, table)[0]; if (!recipe) throw Error('Recipe unavailable');
        await bounded(bot.craft(recipe, integer(args.count ?? 1, 1, 64), table), protocol.limits.maxProgramMs); return null;
      }
      case 'interact': {
        const position = point(args);
        if (position.distanceTo(bot.entity.position) > 5) throw Error('Interaction out of range');
        const block = bot.blockAt(position); if (!block) throw Error('Unloaded block');
        await bounded(bot.activateBlock(block), protocol.limits.maxProgramMs); return null;
      }
      case 'attack': {
        const entity = bot.entities[integer(args.entityId, 0, 2147483647)];
        if (!entity || entity.position.distanceTo(bot.entity.position) > 4) throw Error('Attack out of range');
        bot.attack(entity); return null;
      }
      default: throw Error('Unknown operation');
    }
  } finally { busy.delete(participant); }
}
async function main() {
  await Promise.all(protocol.participants.map(username => new Promise((resolve, reject) => {
    const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username, version: '1.20.4', auth: 'offline' });
    bot.loadPlugin(pathfinder);
    bot.on('error', reject); bot.once('kicked', reason => reject(Error(String(reason))));
    bot.on('chat', (name, message) => { if (protocol.participants.includes(name)) {
      chat.push({ participant: name, message }); if (chat.length > 100) chat.shift();
      console.log(JSON.stringify({ event: 'team-chat', participant: name, message, atMs: Date.now() })); } });
    bot.on('death', () => console.log(JSON.stringify({ event: 'death', participant: username, atMs: Date.now() })));
    bot._client.on('advancements', data => { bot._papercuspAdvancements = Object.keys(data.progressMapping || {}).slice(0, 500); });
    bot.once('spawn', () => { const movements = new Movements(bot); movements.canDig = protocol.actions.includes('mine');
      movements.allow1by1towers = false; bot.pathfinder.setMovements(movements); bots.set(username, bot); resolve(); });
  })));
  const server = http.createServer((req, res) => {
    let body = ''; let bytes = 0;
    const timer = setTimeout(() => req.destroy(), protocol.limits.maxProgramMs);
    req.on('close', () => clearTimeout(timer));
    req.on('data', chunk => { bytes += chunk.length; if (bytes > 16384) req.destroy(); else body += chunk; });
    req.on('end', async () => {
      try { const request = JSON.parse(body);
        if (!request || typeof request.operation !== 'string' || !request.args || typeof request.args !== 'object') throw Error('Malformed gameplay request');
        const value = await invoke(request.participant, request.operation, request.args);
        res.end(JSON.stringify({ ok: true, value }));
      } catch (error) { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: String(error.message).slice(0, 2000) })); }
    });
  });
  server.listen('/bridge/bot.sock', () => { fs.chmodSync('/bridge/bot.sock', 0o666);
    console.log(JSON.stringify({ ready: true, participants: [...bots.keys()] })); });
}
main().catch(error => { console.error(error); process.exit(1); });
