{
  "name": "{{name}}",
  "engine": "aws-cdk",
  "defaultEnvironment": "dev",
  "environments": {
    "dev": {
      "region": "us-east-1"
    },
    "prod": {
      "region": "us-east-1",
      "production": true
    }
  }
}
