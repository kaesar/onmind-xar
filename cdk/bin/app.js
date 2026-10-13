#!/usr/bin/env node
// OnMind-XAR CDK app (JavaScript, CJS). See ARCHITECTURE.md.
'use strict'
const cdk = require('aws-cdk-lib')
const { XarStack } = require('../lib/xar-stack')

const app = new cdk.App()

const termination = app.node.tryGetContext('terminationProtection')
const terminationProtection = termination === true || termination === 'true'

new XarStack(app, 'XarStack', {
  description: 'OnMind-XAR: Lambda + DynamoDB (xrepos+xartifacts) + S3 + HTTP API',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  terminationProtection,
})

app.synth()
