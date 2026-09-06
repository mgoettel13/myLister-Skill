import { createInterface } from 'node:readline';

// Supply one JSON line on stdin so database credentials never appear in process arguments.
const input = createInterface({ input: process.stdin });
input.once('line', async line => {
  input.close();
  process.stdin.pause();
  const config = JSON.parse(line);
  if (typeof config.mongoUrl !== 'string') throw new Error('mongoUrl is required');
  process.env.MONGODB_TEST_URL = config.mongoUrl;
  await import('../dist/store.integration.test.js');
});
