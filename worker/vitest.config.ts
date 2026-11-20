import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		name: 'unit',
		environment: 'node',
		include: ['test/**/*.test.ts'],
		exclude: ['**/node_modules/**', 'test/workers/**'],
	},
});
