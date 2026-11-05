import { configDefaults, defineConfig } from 'vitest/config'

// resources/skills/* ship standalone Node scripts whose tests use node:test, not Vitest;
// `npm test` runs them separately with `node --test`.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, 'resources/**'] }
})
