// OnMind-XAR stack: one Lambda (Hono app) fronted by an HTTP API (API Gateway v2)
// backed by two DynamoDB tables + one S3 bucket. The Lambda code is an ASSET
// of the REPO ROOT (the same tree the Bun container runs), so `src/lambda.handler` +
// node_modules ship as-is — no bundling step.
//
// Auth is enforced by the app, not the gateway (same parity idea as XIN):
// XAR_API_KEY (except /health).
//
// Config is CDK context (cdk.json defaults, overridable with -c key=value):
//   apiKey           OPTIONAL: XAR_API_KEY. Prefer the XAR_API_KEY env var.
//                    Empty = open API (fine for throwaway; set it in prod).
//   removalPolicy    retain (default, prod) | destroy (throwaway envs)
//   deletionProtection  true (default) | false
//   pointInTimeRecovery true (default) | false — 35-day PITR
//   tablePrefix      prepended to xrepos/xartifacts/bucket (multi-env accounts)
//   xarEnv           XAR_ENV for the app (default production)
//   corsOrigins      comma list → XAR_CORS_ORIGINS
//   docker           true (default) | false — mount OnMind-XCR at /v2/* (OCI)
//   localEndpoint    emulator URL → AWS_ENDPOINT_URL + XAR_DYNAMO_ENDPOINT + XAR_S3_ENDPOINT
'use strict'
const path = require('node:path')
const cdk = require('aws-cdk-lib')
const lambda = require('aws-cdk-lib/aws-lambda')
const dynamodb = require('aws-cdk-lib/aws-dynamodb')
const s3 = require('aws-cdk-lib/aws-s3')
const apigwv2 = require('aws-cdk-lib/aws-apigatewayv2')
const { HttpLambdaIntegration } = require('aws-cdk-lib/aws-apigatewayv2-integrations')
const logs = require('aws-cdk-lib/aws-logs')

const REPO_ROOT = path.join(__dirname, '..', '..')

function ctx(stack, key, def = '') {
  const v = stack.node.tryGetContext(key)
  return v === undefined || v === null || v === '' ? def : v
}

function ctxBool(stack, key, def) {
  const v = stack.node.tryGetContext(key)
  if (v === undefined || v === null || v === '') return def
  return v === true || v === 'true'
}

function ctxList(stack, key) {
  return String(ctx(stack, key, ''))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

class XarStack extends cdk.Stack {
  constructor(scope, id, props = {}) {
    super(scope, id, props)

    const tablePrefix = String(ctx(this, 'tablePrefix', ''))
    const removal =
      String(ctx(this, 'removalPolicy', 'retain')).toLowerCase() === 'destroy'
        ? cdk.RemovalPolicy.DESTROY
        : cdk.RemovalPolicy.RETAIN
    const deletionProtection = ctxBool(this, 'deletionProtection', true)
    const pitr = ctxBool(this, 'pointInTimeRecovery', true)

    // ---------- DynamoDB ----------
    // Schema must match src/storage.js: xrepos pk name S + data S;
    // xartifacts pk key S (= repo:path), expiresAt N (TTL), data S.
    const reposTable = new dynamodb.Table(this, 'xreposTable', {
      tableName: `${tablePrefix}xrepos`,
      partitionKey: { name: 'name', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: pitr },
      removalPolicy: removal,
      deletionProtection,
    })

    const artifactsTable = new dynamodb.Table(this, 'xartifactsTable', {
      tableName: `${tablePrefix}xartifacts`,
      partitionKey: { name: 'key', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: pitr },
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: removal,
      deletionProtection,
    })

    // ---------- S3 (blobs content-addressed) ----------
    const bucket = new s3.Bucket(this, 'xarBlobs', {
      bucketName: `${tablePrefix}xar-artifacts-${this.account}-${this.region}`.toLowerCase().slice(0, 63),
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: removal,
      autoDeleteObjects: removal === cdk.RemovalPolicy.DESTROY,
    })

    // ---------- Lambda env ----------
    const apiKey = process.env.XAR_API_KEY || String(ctx(this, 'apiKey', ''))

    const fnEnv = {
      XAR_ENV: String(ctx(this, 'xarEnv', 'production')),
      XAR_STORAGE: 'dynamodb',
      XAR_TABLE_REPOS: reposTable.tableName,
      XAR_TABLE_ARTIFACTS: artifactsTable.tableName,
      XAR_BLOB: 's3',
      XAR_S3_BUCKET: bucket.bucketName,
      XAR_S3_PREFIX: 'artifacts/',
    }
    if (apiKey) fnEnv.XAR_API_KEY = apiKey
    const cors = ctxList(this, 'corsOrigins')
    if (cors.length) fnEnv.XAR_CORS_ORIGINS = cors.join(',')

    const localEndpoint = String(ctx(this, 'localEndpoint', ''))
    if (localEndpoint) {
      fnEnv.AWS_ENDPOINT_URL = localEndpoint
      fnEnv.XAR_DYNAMO_ENDPOINT = localEndpoint
      fnEnv.XAR_S3_ENDPOINT = localEndpoint
    }

    // ---------- Docker/OCI: OnMind-XCR as a dependency (/v2/*) ----------
    // docker=false → packages-only; true (default) → XCR mounted, images in
    // the same bucket under its own prefix (XCR_STORAGE=s3).
    const dockerOff = !ctxBool(this, 'docker', true)
    fnEnv.XAR_DOCKER = dockerOff ? 'off' : 'on'
    if (!dockerOff) {
      fnEnv.XCR_STORAGE = 's3'
      fnEnv.XCR_S3_BUCKET = bucket.bucketName
      fnEnv.XCR_S3_PREFIX = 'docker-registry/'
      if (localEndpoint) fnEnv.XCR_S3_ENDPOINT = localEndpoint
    }

    // ---------- Lambda ----------
    const xarFn = new lambda.Function(this, 'XarFunction', {
      description: 'OnMind-XAR artifacts proxy-cache (Hono)',
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'src/lambda.handler',
      code: lambda.Code.fromAsset(REPO_ROOT, {
        exclude: [
          '.git',
          '.github',
          'cdk',
          'PLAN.md',
          'xpacks.json',
          'files',
          '.env',
          '.dev.vars',
          '*.log',
          'bun.lock',
        ],
      }),
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      environment: fnEnv,
      logGroup: new logs.LogGroup(this, 'XarLogs', {
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: removal,
      }),
    })
    reposTable.grantReadWriteData(xarFn)
    artifactsTable.grantReadWriteData(xarFn)
    bucket.grantReadWrite(xarFn)

    // ---------- HTTP API ----------
    const api = new apigwv2.HttpApi(this, 'XarHttpApi', {
      apiName: `${tablePrefix}xar-api`,
      description: 'OnMind-XAR API (repos admin + proxy-cache)',
    })

    const integration = new HttpLambdaIntegration('LambdaIntegration', xarFn)
    api.addRoutes({ path: '/{proxy+}', methods: [apigwv2.HttpMethod.ANY], integration })
    api.addRoutes({ path: '/', methods: [apigwv2.HttpMethod.ANY], integration })

    // ---------- Outputs ----------
    new cdk.CfnOutput(this, 'ApiEndpoint', { value: api.apiEndpoint })
    new cdk.CfnOutput(this, 'ApiId', { value: api.apiId })
    new cdk.CfnOutput(this, 'FunctionName', { value: xarFn.functionName })
    new cdk.CfnOutput(this, 'ReposTable', { value: reposTable.tableName })
    new cdk.CfnOutput(this, 'ArtifactsTable', { value: artifactsTable.tableName })
    new cdk.CfnOutput(this, 'BlobsBucket', { value: bucket.bucketName })
  }
}

module.exports = { XarStack }
