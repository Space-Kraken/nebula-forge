{
  "name": "{{name}}",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "test": "vitest run",
    "synth": "forge synth",
    "cdk": "cdk"
  },
  "dependencies": {
    "@space-kraken/nebula-forge-core": "{{coreDep}}",
    "@space-kraken/nebula-forge-engine-cdk": "{{engineDep}}",
    "@fusion-framework/server": "^1.4.1",
    "aws-cdk-lib": "^2.200.0",
    "constructs": "^10.3.0",
    "reflect-metadata": "^0.2.2"
  },
  "devDependencies": {
    "@space-kraken/nebula-forge": "{{cliDep}}",
    "@types/aws-lambda": "^8.10.140",
    "@types/node": "^20.14.0",
    "aws-cdk": "^2.150.0",
    "esbuild": "^0.23.0",
    "tsx": "^4.16.0",
    "typescript": "^5.5.4",
    "vitest": "^2.0.5"
  }
}
