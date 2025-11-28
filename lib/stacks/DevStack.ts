import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam'; 
import { Tags } from 'aws-cdk-lib';

export class DevStack extends cdk.Stack {
  public readonly devInstance: ec2.Instance;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // VPC for dev environment (2 AZs to keep networking simple)
    const vpc = new ec2.Vpc(this, 'DevVpc', {
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'PrivateSubnet',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],
    });

    // Elastic IP for dev instance
    const eip = new ec2.CfnEIP(this, 'DevInstanceEIP', {
      domain: 'vpc',
      tags: [{ key: 'Name', value: 'HealthDevInstanceEIP' }],
    });

    // Security group allowing SSH for deploy pipeline
    const sg = new ec2.SecurityGroup(this, 'DevInstanceSG', {
      vpc,
      allowAllOutbound: true,
      description: 'Security group for dev EC2 instance',
    });

    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(22), 'Allow SSH');
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Allow HTTP traffic');
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Allow HTTPS traffic');
    //sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(5173), 'Allow frontend access');
    
    const instanceRole = new iam.Role(this, 'DevInstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
    });
    instanceRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'));
    instanceRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonS3ReadOnlyAccess'));
    this.addPoliciesToInstanceRole(instanceRole);

    // Add VPC endpoints for SSM and S3, this will allow the instance to be managed via SSM without public IP
    vpc.addInterfaceEndpoint('SSMEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SSM,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });
    vpc.addInterfaceEndpoint('SSMMessagesEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SSM_MESSAGES,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });
    vpc.addInterfaceEndpoint('EC2MessagesEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.EC2_MESSAGES,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });
    vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
      subnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
    });


    // EC2 instance with extra EBS volume for Docker + Cassandra
    this.devInstance = new ec2.Instance(this, 'DevInstance', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
      machineImage: ec2.MachineImage.latestAmazonLinux({
        generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2,
      }),
      securityGroup: sg,
      role: instanceRole,

      blockDevices: [
        {
          deviceName: '/dev/xvda', // root volume
          volume: ec2.BlockDeviceVolume.ebs(16, { volumeType: ec2.EbsDeviceVolumeType.GP3 }),
        },
        {
          deviceName: '/dev/sdh', // data volume for Docker + Cassandra
          volume: ec2.BlockDeviceVolume.ebs(200, { volumeType: ec2.EbsDeviceVolumeType.GP3 }),
        },
      ],
    });

    new ec2.CfnEIPAssociation(this, "DevInstanceEIPAssoc", {
      eip: eip.ref,
      instanceId: this.devInstance.instanceId,
    });

    Tags.of(this.devInstance).add('HealthEnv', 'dev');

    this.devInstance.userData.addCommands(
      "set -xe",

      // ---------- Disk Setup ----------
      "sudo mkfs -t xfs /dev/sdh || true",
      "sudo mkdir -p /data",
      "echo '/dev/sdh /data xfs defaults,nofail 0 2' | sudo tee -a /etc/fstab",
      "sudo mount -a || true",

      // ---------- System Update ----------
      "sudo yum update -y",

      // ---------- Docker Setup ----------
      "sudo amazon-linux-extras enable docker",
      "sudo yum install -y docker python3-pip jq",
      "sudo systemctl enable --now docker",
      "sudo pip3 install docker-compose",
      "sudo usermod -aG docker ec2-user",

      // Move Docker data root
      "sudo systemctl stop docker",
      "sudo mkdir -p /data/docker",
      "sudo rsync -aP /var/lib/docker/ /data/docker/ || true",
      "sudo sed -i 's|^ExecStart=.*|ExecStart=/usr/bin/dockerd --data-root=/data/docker|' /usr/lib/systemd/system/docker.service",
      "sudo systemctl daemon-reload",
      "sudo systemctl start docker",

      // ---------- NGINX Setup ----------
      "sudo amazon-linux-extras enable nginx1",
      "sudo amazon-linux-extras install -y nginx1",
      "sudo yum install -y openssl",
      "sudo mkdir -p /etc/nginx/conf.d",

      // ---------- Prepare webroot for Certbot ----------
      "sudo mkdir -p /var/www/certbot/.well-known/acme-challenge",
      "sudo chown -R ec2-user:ec2-user /var/www/certbot",
      "sudo chmod -R 755 /var/www/certbot",

      // Write minimal HTTP-only config for Certbot first
      `sudo tee /etc/nginx/conf.d/frontend.conf << 'EOF'
server {
    listen 80;
    server_name dev.aegiscan.app;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot/;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}
EOF`,

      "sudo systemctl enable nginx",

      // ---------- Certbot Setup ----------
      "sudo amazon-linux-extras enable epel",
      "sudo yum install -y epel-release",
      "sudo yum install -y certbot",
    );
  }

  private addPoliciesToInstanceRole(role: iam.Role) {

    role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:GetSecretValue'],
      resources: [
        'arn:aws:secretsmanager:us-east-1:774814055379:secret:HealthAI-DevServerAPIKey-*'
      ],
    }));

    role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:PutObject', 's3:GetObject'],
      resources: ['arn:aws:s3:::health-workspace-deploy-774814055379-us-east-1/*'],
    }));

    // S3 access for AI model storage
    role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject', 's3:PutObject'],
      resources: [
        'arn:aws:s3:::ai-health-model-storage/*',
        'arn:aws:s3:::aihealthinfra-modelsresults/*'
      ],
    }));
  }
}
