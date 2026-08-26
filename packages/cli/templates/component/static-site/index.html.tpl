<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{{name}}</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        font-family: system-ui, sans-serif;
        background: #0f172a;
        color: #e2e8f0;
      }
      main { text-align: center; }
      code { color: #7dd3fc; }
    </style>
  </head>
  <body>
    <main>
      <h1>{{module}}/{{name}}</h1>
      <p>Static site served from S3 through CloudFront.</p>
      <p>Replace the contents of <code>site/</code> with your build output (or point <code>config.sourceDir</code> at it).</p>
    </main>
  </body>
</html>
