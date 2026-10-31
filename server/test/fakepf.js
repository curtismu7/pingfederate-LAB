// The tests' PingFederate: the lab's own mock (src/mockpf.js), answering on https://pf.example.
import { createMockPf, USER } from '../src/mockpf.js';

export const ORIGIN = 'https://pf.example';
export { USER };
export const createFakePf = (options = {}) => createMockPf({ origin: ORIGIN, ...options });
