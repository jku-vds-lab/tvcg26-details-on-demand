// jest.config.js or jest.config.cjs
/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest/presets/js-with-ts-esm',
  testEnvironment: 'jsdom',

  roots: ['<rootDir>/src'],
  testMatch: ['**/?(*.)+(spec|test).@(ts|tsx)'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],

  // make ts-jest handle both .ts/.tsx and .js/.jsx ESM modules
  transform: {
    '^.+\\.([tj]sx?)$': ['ts-jest', {
      tsconfig: './tsconfig.jest.json',
      useESM: true
    }]
  },

  moduleNameMapper: {
    // resolve the scaling seam to the open-core stub
    '^@scaling$': '<rootDir>/src/scaling.stub.ts',

    // workerFactories uses `new URL(..., import.meta.url)` (Vite worker
    // convention), which ts-jest's CJS module target cannot compile (TS1343)
    // — map it to a loadable stub so import chains reaching it don't kill
    // whole suites at load time. Behavior-level worker mocking stays in the
    // individual tests (make*Worker wrappers / hdbscanWorkerProxy).
    'workerFactories$': '<rootDir>/src/mocks/workerFactoriesMock.ts',
    // allow absolute imports from the src directory
    '^src/(.*)$': '<rootDir>/src/$1',
    // handle CSS imports
    '\\.(css|less|sass|scss)$': 'identity-obj-proxy',

    // map top-level `d3` to the UMD bundle. Since the packages/ restructure
    // the repo root is an npm-workspaces umbrella: dependencies are hoisted
    // to <repoRoot>/node_modules, so probe the package-local dir first and
    // fall back to the hoisted workspace root (jest tries array entries in
    // order until one resolves).
    '^d3$': [
      '<rootDir>/node_modules/d3/dist/d3.min.js',
      '<rootDir>/../../node_modules/d3/dist/d3.min.js',
    ],

    // correctly interpolate the submodule name with $1
    '^d3-(.+)$': [
      '<rootDir>/node_modules/d3-$1/dist/d3-$1.min.js',
      '<rootDir>/../../node_modules/d3-$1/dist/d3-$1.min.js',
    ],

    // allow absolute imports from src
    '^src/(.*)$': '<rootDir>/src/$1',

    // stub out CSS imports
    '\\.(css)$': '<rootDir>/src/mocks/fileMock.ts',

    // stub out SVG ?react Vite transforms (not supported in Jest) with a
    // renderable React component
    '\\.svg\\?react$': '<rootDir>/src/mocks/svgComponentMock.tsx',

    // stub out plain SVG url imports (e.g. PSEIcons)
    '\\.svg$': '<rootDir>/src/mocks/fileMock.ts',

    // stub out PNG/image imports (Vite inlines them; Jest just needs a string)
    '\\.(png|jpg|jpeg|gif|webp)$': '<rootDir>/src/mocks/fileMock.ts'
  }
};
