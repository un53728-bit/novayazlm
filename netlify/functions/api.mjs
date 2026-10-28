import { getStore } from '@netlify/blobs';
import { handle } from './lib.mjs';

export default async (req, context) => {
  const store = getStore({ name: 'arda', consistency: 'strong' });
  return handle(req, store, process.env, context && context.ip);
};

export const config = { path: '/api/*' };
