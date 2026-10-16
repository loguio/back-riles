module.exports = {
  moduleFileExtensions: ["js", "json", "ts"],
  rootDir: "src",
  testRegex: ".*\\.spec\\.ts$",
  transform: { "^.+\\.(t|j)s$": ["ts-jest", { tsconfig: "<rootDir>/../tsconfig.json" }] },
  testEnvironment: "node",
  testTimeout: 20000,
};
