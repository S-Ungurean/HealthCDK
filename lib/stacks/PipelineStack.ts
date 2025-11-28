import * as cdk from 'aws-cdk-lib';
import { Stack, StackProps, SecretValue } from 'aws-cdk-lib';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as cpactions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import { Construct } from 'constructs';
import { DevStack } from './DevStack';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as fs from 'fs';
import * as path from 'path';

interface PipelineStackProps extends StackProps {
  deployBucketName: string;
}

export class PipelineStack extends Stack {
  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);

    const { deployBucketName } = props;

    const pipeline = new codepipeline.Pipeline(this, "HealthServicePipeline", {
      pipelineName: "HealthServicePipeline"
    });

    // Source stage
    const repoArtifacts: { [key: string]: codepipeline.Artifact } = {};
    const sourceStage = pipeline.addStage({ stageName: 'Source' });

    // Workspace repo goes at the root
    repoArtifacts['HealthWorkspace'] = new codepipeline.Artifact('HealthWorkspace');
    sourceStage.addAction(
      new cpactions.GitHubSourceAction({
        actionName: 'HealthWorkspace',
        owner: 'S-Ungurean',
        repo: 'HealthWorkspace',
        branch: 'master',
        oauthToken: SecretValue.secretsManager('GITHUB_TOKEN'),
        output: repoArtifacts['HealthWorkspace'],
        trigger: cpactions.GitHubTrigger.WEBHOOK,
      })
    );

    ['HealthBEService','HealthDAO','HealthSAO','HealthFEService','HealthInferenceService','HealthCDK','HealthIntegrationTests'].forEach((repo) => {
      const artifact = new codepipeline.Artifact(`${repo}`);
      repoArtifacts[repo] = artifact;
      sourceStage.addAction(
        new cpactions.GitHubSourceAction({
          actionName: `${repo}`,
          owner: 'S-Ungurean',
          repo,
          branch: 'main',
          oauthToken: SecretValue.secretsManager('GITHUB_TOKEN'),
          output: artifact,
          trigger: cpactions.GitHubTrigger.WEBHOOK,
        })
      );
    });

    // Package stage (does the building)
    const packager = this.createPackagerProject(deployBucketName);
    packager.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:PutObject', 's3:GetObject', 's3:ListBucket'],
      resources: [
        `arn:aws:s3:::${deployBucketName}`,
        `arn:aws:s3:::${deployBucketName}/*`
      ],
    }));
    pipeline.addStage({ stageName: 'Package' }).addAction(new cpactions.CodeBuildAction({
      actionName: 'Package_Workspace',
      project: packager,
      input: repoArtifacts['HealthWorkspace']
    }));

    // Deploy stage
    const deployProject = this.createDockerComposeDeployProject(deployBucketName);
    deployProject.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:SendCommand', 'ssm:GetCommandInvocation', 'ssm:ListCommands', 'ssm:ListCommandInvocations'],
      resources: ['*'],
    }));
    deployProject.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:PutObject', 's3:GetObject', 's3:ListBucket'],
      resources: [
        `arn:aws:s3:::${deployBucketName}`,
        `arn:aws:s3:::${deployBucketName}/*`
      ],
    }));
    pipeline.addStage({ stageName: 'DeployToDev' }).addAction(new cpactions.CodeBuildAction({
      actionName: 'Deploy_DockerCompose',
      project: deployProject,
      input: repoArtifacts['HealthWorkspace']
    }));

    // Integration Test Stage
    const integrationTestProject = this.createIntegrationTestRun();
    integrationTestProject.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:SendCommand', 'ssm:GetCommandInvocation', 'ssm:ListCommands', 'ssm:ListCommandInvocations'],
      resources: ['*'],
    }));
    pipeline.addStage({ stageName: 'IntegrationTests' }).addAction(new cpactions.CodeBuildAction({
      actionName: 'Run_Integration_Tests',
      project: integrationTestProject,
      input: repoArtifacts['HealthIntegrationTests']
    }));
  }

  private createPackagerProject(deployBucketName: String): codebuild.PipelineProject {
    return new codebuild.PipelineProject(this, 'WorkspacePackager', {
      projectName: 'WorkspacePackager',
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        privileged: true,
      },
      environmentVariables: {
        GITHUB_TOKEN: {
          type: codebuild.BuildEnvironmentVariableType.SECRETS_MANAGER,
          value: 'GITHUB_TOKEN',
        },
        DEPLOY_BUCKET_NAME: { value: deployBucketName },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',

        phases: {
          install: {
            commands: [
              'echo Installing JDK17 + git...',
              'yum update -y || true',
              'yum install -y java-17-amazon-corretto-devel git tar jq || true'
            ],
          },

          build: {
            commands: [
              'set -e',
              'echo "==== CLEANING WORKSPACE ===="',
              'rm -rf /tmp/build-artifacts || true',
              'mkdir -p /tmp/build-artifacts/workspace',
              'cd /tmp/build-artifacts/workspace',
              'pwd',
              'ls',
              'echo "==== CLONING REPOSITORIES ===="',
              // Workspace root folder
              'git clone --depth 1 https://$GITHUB_TOKEN@github.com/S-Ungurean/HealthWorkspace.git .',
              'ls',
              // Submodules inside workspace/
              'git clone --depth 1 https://$GITHUB_TOKEN@github.com/S-Ungurean/HealthCDK.git HealthCDK',
              'cd HealthCDK',
              'aws s3 cp resources/frontend.conf s3://$DEPLOY_BUCKET_NAME/frontend.conf',
              'cd ..',
              'git clone --depth 1 https://$GITHUB_TOKEN@github.com/S-Ungurean/HealthDAO.git HealthDAO',
              'pwd',
              'ls',
              'git clone --depth 1 https://$GITHUB_TOKEN@github.com/S-Ungurean/HealthSAO.git HealthSAO',
              'git clone --depth 1 https://$GITHUB_TOKEN@github.com/S-Ungurean/HealthBEService.git HealthBEService',
              'git clone --depth 1 https://$GITHUB_TOKEN@github.com/S-Ungurean/HealthFEService.git HealthFEService',
              'git clone --depth 1 https://$GITHUB_TOKEN@github.com/S-Ungurean/HealthInferenceService.git HealthInferenceService',
              'git clone --depth 1 https://$GITHUB_TOKEN@github.com/S-Ungurean/HealthIntegrationTests.git HealthIntegrationTests',
              'pwd',
              'ls',
              'echo "==== BUILDING DAO ===="',
              '(cd HealthDAO && chmod +x gradlew && ./gradlew clean build -x test)',

              'echo "==== BUILDING SAO ===="',
              '(cd HealthSAO && chmod +x gradlew && ./gradlew clean build -x test)',

              'echo "==== BUILDING BACKEND ===="',
              '(cd HealthBEService && chmod +x gradlew && ./gradlew clean build -x test)',

              'echo "==== PACKAGING WORKSPACE ===="',
              'cd /tmp/build-artifacts',
              'tar -czf docker_workspace.tar.gz workspace',
              'aws s3 cp docker_workspace.tar.gz s3://$DEPLOY_BUCKET_NAME/docker_workspace.tar.gz',
              'echo "Packaging complete!"'
            ],
          },
        },
        artifacts: {
          files: [],
        },
      }),
    });
  }

  private createDockerComposeDeployProject(deployBucketName: string): codebuild.PipelineProject {
    return new codebuild.PipelineProject(this, 'DockerComposeDeploy', {
      projectName: 'DockerComposeDeploy',
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_CORETTO_8, // Amazon Linux 2 with yum
        privileged: true,
      },
      environmentVariables: {
        DEPLOY_BUCKET_NAME: { value: deployBucketName },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
          commands: [
            'set -e',
            'echo "Preparing SSM command JSON file..."',
            // Use cat <<EOF for clean multi-line JSON
            `cat > commands.json <<EOF
{
  "commands": [
    "sudo systemctl stop nginx",
    "sudo systemctl start nginx",
    "sudo nginx -t",
    "echo test | sudo tee /var/www/certbot/.well-known/acme-challenge/testfile",
    "curl http://dev.aegiscan.app/.well-known/acme-challenge/testfile",
    "bash -c 'set -e; sudo certbot certonly --webroot -w /var/www/certbot -d dev.aegiscan.app --agree-tos --register-unsafely-without-email --non-interactive'",
    "bash -c 'set -e; aws s3 cp s3://$DEPLOY_BUCKET_NAME/frontend.conf /etc/nginx/conf.d/frontend.conf'",
    "bash -c 'set -e; sudo nginx -t'",
    "sudo systemctl stop nginx",
    "sudo systemctl start nginx",

    "(crontab -l 2>/dev/null; echo \\"0 0,12 * * * /usr/bin/certbot renew --quiet --post-hook 'systemctl reload nginx'\\" ) | crontab -",

    "sudo curl -SL https://github.com/docker/compose/releases/download/v2.20.2/docker-compose-linux-x86_64 -o /usr/local/bin/docker-compose",
    "sudo chmod +x /usr/local/bin/docker-compose",
    "docker-compose --version",
    "aws s3 cp s3://$DEPLOY_BUCKET_NAME/docker_workspace.tar.gz /home/ec2-user/docker_workspace.tar.gz",
    "cd /home/ec2-user && tar -xzf docker_workspace.tar.gz",
    "cd /home/ec2-user/workspace",
    "docker-compose down",
    "docker system prune -f",
    "docker-compose up -d --build",
    "echo 'Waiting 3 minutes for containers to start...'",
    "sleep 180",
    "docker ps --format '{{.Names}} {{.Status}}' | grep -q healthai || exit 1",
    "docker ps --format '{{.Names}} {{.Status}}' | grep -q healthfe || exit 1",
    "docker ps --format '{{.Names}} {{.Status}}' | grep -q healthpy || exit 1",
    "docker ps --format '{{.Names}} {{.Status}}' | grep -q cassandra || exit 1"
  ]
}
EOF`,
            'echo "Sending SSM command to deploy workspace..."',
            'COMMAND_ID=$(aws ssm send-command --targets "Key=tag:HealthEnv,Values=dev" --document-name "AWS-RunShellScript" --comment "Deploy full workspace" --parameters file://commands.json --timeout-seconds 1800 --query "Command.CommandId" --output text)',
            'echo "SSM command sent, polling for status..."',
            // Poll for SSM command completion
            'for i in $(seq 1 20); do STATUS=$(aws ssm list-command-invocations --command-id "$COMMAND_ID" --details --query "CommandInvocations[0].Status" --output text); echo "Current SSM status: $STATUS"; if [ "$STATUS" = "Success" ]; then echo "✅ Deployment completed"; exit 0; fi; if [ "$STATUS" = "Failed" ]; then echo "❌ Deployment failed"; exit 1; fi; sleep 30; done; echo "⚠️ Deployment timed out waiting for SSM command to finish"; exit 1'

          ],
        },
      },
        artifacts: { files: [] },
      }),
    });
  }

  private createIntegrationTestRun() {
    return new codebuild.PipelineProject(this, 'DevIntegrationTestRun', {
      projectName: 'DevIntegrationTestRun',
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_CORETTO_8, // Amazon Linux 2 with yum
        privileged: true,
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
          commands: [
            'set -e',
            'echo "Preparing SSM command JSON file..."',
            // Use cat <<EOF for clean multi-line JSON
            `cat > commands.json <<EOF
{
  "commands": [
    "echo 'Checking if docker containers are running...'",
    "docker ps --format '{{.Names}} {{.Status}}' | grep -q healthai || exit 1",
    "docker ps --format '{{.Names}} {{.Status}}' | grep -q healthfe || exit 1",
    "docker ps --format '{{.Names}} {{.Status}}' | grep -q healthpy || exit 1",
    "docker ps --format '{{.Names}} {{.Status}}' | grep -q cassandra || exit 1",
    "cd /home/ec2-user/workspace",
    "cd HealthIntegrationTests && chmod +x gradlew && ./gradlew test --tests "org.dev.HealthDevBEIntegrationTestSuite")",
  ]
}
EOF`,
            'echo "Sending SSM command to deploy workspace..."',
            'COMMAND_ID=$(aws ssm send-command --targets "Key=tag:HealthEnv,Values=dev" --document-name "AWS-RunShellScript" --comment "Run Dev Integration Tests" --parameters file://commands.json --timeout-seconds 1800 --query "Command.CommandId" --output text)',
            'echo "SSM command sent, polling for status..."',
            // Poll for SSM command completion
            'for i in $(seq 1 20); do STATUS=$(aws ssm list-command-invocations --command-id "$COMMAND_ID" --details --query "CommandInvocations[0].Status" --output text); echo "Current SSM status: $STATUS"; if [ "$STATUS" = "Success" ]; then echo "✅ Deployment completed"; exit 0; fi; if [ "$STATUS" = "Failed" ]; then echo "❌ Deployment failed"; exit 1; fi; sleep 30; done; echo "⚠️ Deployment timed out waiting for SSM command to finish"; exit 1'

          ],
        },
      },
        artifacts: { files: [] },
      }),
    });
  }
}