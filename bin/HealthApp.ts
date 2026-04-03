import * as cdk from 'aws-cdk-lib';
import { PipelineStack } from '../lib/stacks/PipelineStack';
import { DevStack } from '../lib/stacks/DevStack';
import { S3Stack } from '../lib/stacks/S3Stack';
import { StorageStack } from '../lib/stacks/StorageStack';

const app = new cdk.App();


const bucketStack = new S3Stack(app, 'S3Stack', {
  env: { account: '774814055379', region: 'us-east-1' },
});

// Deploy StorageStack
const storageStack = new StorageStack(app, 'StorageStack', {
  env: { account: '774814055379', region: 'us-east-1' },
});

// Deploy DevStack separately (EC2 infra)
new DevStack(app, 'HealthDevInfra', {
  env: { account: '774814055379', region: 'us-east-1' },
  sorterLambdaArn: storageStack.sorterLambda.functionArn,
});

// Deploy PipelineStack
new PipelineStack(app, 'HealthPipelineStack', {
  env: { account: "774814055379", region: "us-east-1" },
  deployBucketName: bucketStack.deployBucket.bucketName,
});
app.synth();