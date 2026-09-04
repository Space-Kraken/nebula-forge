{
  "name": "{{name}}",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "test": "vitest run",
    "synth": "forge synth"
  },
  "dependencies": {
    "@azure/functions": "^4.5.0",
    "@space-kraken/nebula-forge-core": "{{coreDep}}",
    "@space-kraken/nebula-forge-engine-azure-tf": "{{engineDep}}"
  },
  "devDependencies": {
    "@space-kraken/nebula-forge": "{{cliDep}}",
    "@types/node": "^20.14.0",
    "tsx": "^4.16.0",
    "typescript": "^5.5.4",
    "vitest": "^2.0.5"
  }
}
