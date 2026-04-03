import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';

export class StorageStack extends cdk.Stack {
  public readonly humanBucket: s3.Bucket;
  public readonly animalBucket: s3.Bucket;
  public readonly sorterLambda: lambda.Function;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.humanBucket = new s3.Bucket(this, 'HumanMedicalBucket', {
      bucketName: `health-human-data-${this.account}-${this.region}`,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.animalBucket = new s3.Bucket(this, 'AnimalMedicalBucket', {
      bucketName: `health-animal-data-${this.account}-${this.region}`,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const lambdaRole = new iam.Role(this, 'ImageSorterLambdaRole', {
      roleName: `HealthSorterRole-${this.region}`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    this.sorterLambda = new lambda.Function(this, 'ImageSorterLambda', {
      functionName: 'health-image-sorter',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'sorter.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../scripts')),
      role: lambdaRole,
      environment: {
        HUMAN_BUCKET_NAME: this.humanBucket.bucketName,
        ANIMAL_BUCKET_NAME: this.animalBucket.bucketName,
      },
    });

    lambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject'],
      resources: ['arn:aws:s3:::aegiscaninputs/*'],
    }));

    lambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:PutObject', 's3:PutObjectTagging'],
      resources: [
        `${this.humanBucket.bucketArn}/*`,
        `${this.animalBucket.bucketArn}/*`
      ],
    }));
  }
}