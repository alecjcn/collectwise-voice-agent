// Print a shareable browser test URL for the deployed agent.
//
// Each invocation mints a token for a RANDOM room name: join tokens pin one
// room, agent dispatch fires only on room creation, and a finished call's
// teardown races a re-creation of the same name - so every conversation
// should get its own room. Usage: pnpm demo:link
import dotenv from 'dotenv';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

dotenv.config({ path: '.env.local' });

const room = `atlas-${randomBytes(4).toString('hex')}`;
const output = execFileSync(
  'lk',
  ['token', 'create', '--join', '--room', room, '--identity', 'caller', '--valid-for', '720h'],
  { encoding: 'utf8' },
);
const token = output.match(/Access token:\s+(\S+)/)?.[1];
const host = process.env.LIVEKIT_URL?.replace(/^wss?:\/\//, '');
if (!token || !host) {
  throw new Error(`Could not build link (need lk CLI auth and LIVEKIT_URL). lk output:\n${output}`);
}

console.log(`Room:  ${room}`);
console.log(`Share: https://meet.livekit.io/custom?liveKitUrl=wss://${host}&token=${token}`);
