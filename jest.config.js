module.exports = {
  moduleFileExtensions: ["ts", "js"],
  transform: {
    "^.+\\.(ts|tsx)$": [
      "@swc/jest",
      {
        jsc: {
          target: "es2019",
        },
      },
    ],
  },
  coverageProvider: "v8",
  coverageThreshold: {
    // Auth/users is the security-sensitive shared module: keep its coverage
    // from regressing (measured ~90/81/93/90 when the threshold was added).
    "./src/users/": {
      statements: 80,
      branches: 75,
      functions: 80,
      lines: 80,
    },
  },
  testMatch: ["/**/src/**/*.spec.(ts|js)"],
  testPathIgnorePatterns: ["/node_modules/", "/dist/"],
  testEnvironment: "node",
};
