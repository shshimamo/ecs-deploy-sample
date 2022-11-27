import {RemovalPolicy, SecretValue, Stack, StackProps} from 'aws-cdk-lib';
import { Construct } from 'constructs';

import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import {DockerImageAsset} from "aws-cdk-lib/aws-ecr-assets";
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

import * as ecrdeploy from 'cdk-ecr-deployment';
import * as path from 'path';

export class EcsDeploySampleStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // create a VPC
    const vpc = new ec2.Vpc(this, 'VPC', {
      cidr: '10.0.0.0/16',
      maxAzs: 2,
      subnetConfiguration: [
        {
          // PublicSubnet
          cidrMask: 24,
          name: 'ingress',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          // NATを使う場合
          cidrMask: 24,
          name: 'application',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        {
          // PrivateSubnet
          cidrMask: 24,
          name: 'rds',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        }
      ],
    });

    // create a security group
    // LoadBarancer用のセキュリティグループ
    const securityGroupELB = new ec2.SecurityGroup(this, 'SecurityGroupELB', {
      vpc,
      description: 'Security group ELB',
      securityGroupName: 'SGELB',
    })
    securityGroupELB.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Allow HTTP traffic from the world')

    // ECSで動作するアプリ用のセキュリティグループ
    const securityGroupAPP = new ec2.SecurityGroup(this, 'SecurityGroupAPP', {
      vpc,
      description: 'Security group APP',
      securityGroupName: 'SGAPP',
    })
    securityGroupAPP.addIngressRule(securityGroupELB, ec2.Port.tcp(3000), 'Allow HTTP traffic from the ELB')

    // Security Group PostgreSQL
    const securityGroupRDS = new ec2.SecurityGroup(this, 'SecurityGroupRDS', {
      vpc,
      description: 'Security group RDS',
      securityGroupName: 'SGRDS',
    })
    securityGroupRDS.addIngressRule(securityGroupAPP, ec2.Port.tcp(5432), 'Allow PostgreSQL traffic from the APP')

    // SecretManager
    const databaseCredentialSecret = new secretsmanager.Secret(this, 'databaseCredentialSecret', {
      secretName: "postgresql",
      generateSecretString: {
        excludeCharacters: '"@/\\\'',
        passwordLength: 16,
        excludePunctuation: true,
        includeSpace: false,
        secretStringTemplate: JSON.stringify({
          username: 'dbuser',
        }),
        generateStringKey: 'password',
      }
    })

    // RDS for PostgreSQL
    const postgresql = new rds.DatabaseInstance(this, 'postgresql', {
      engine: rds.DatabaseInstanceEngine.POSTGRES,
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED
      },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE3, ec2.InstanceSize.MICRO),
      securityGroups: [securityGroupRDS],
      // multiAz: true,
      databaseName: 'ecs_deploy_sample',
      removalPolicy: RemovalPolicy.DESTROY,
      credentials: rds.Credentials.fromSecret(databaseCredentialSecret),
    })

    // Application Load Balancer
    const alb = new elbv2.ApplicationLoadBalancer(this, 'ALB', {
      vpc,
      securityGroup: securityGroupELB,
      internetFacing: true, // インターネット向け
      loadBalancerName: 'ALB',
    })

    const listener = alb.addListener('Listener', {
      port: 80,
      open: true,
    })

    // Target Group
    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
      vpc,
      port: 80,
      // port: 3000, // TODO
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
    })

    listener.addTargetGroups('TargetGroup', {
      targetGroups: [targetGroup],
    })

    // ECR image
    const asset = new DockerImageAsset(this, 'DockerImageAsset', {
      directory: path.join(__dirname, '..', 'api'),
    })

    // ECR
    const repository = new ecr.Repository(this, 'Repository', {
      repositoryName: 'ecs-deploy-sample-rails',
      imageScanOnPush: true,
    })

    // ECR deployment
    new ecrdeploy.ECRDeployment(this, 'ECRDeployment', {
      src: new ecrdeploy.DockerImageName(asset.imageUri),
      dest: new ecrdeploy.DockerImageName(`${repository.repositoryUri}:latest`),
    })

    // ECS cluster
    const cluster = new ecs.Cluster(this, 'Cluster', { vpc });

    // オートスケーリンググループ
    // const autoScalingGroup = new autoscaling.AutoScalingGroup(this, "ASG", {
    //   vpc,
    //   instanceType: new ec2.InstanceType("t2.micro"),
    //   machineImage: ecs.EcsOptimizedImage.amazonLinux2(),
    //   vpcSubnets: {
    //     subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
    //   },
    //   minCapacity: 0,
    //   maxCapacity: 10,
    //   securityGroup: securityGroupAPP,
    // });
    //
    // const capacityProvider = new ecs.AsgCapacityProvider(this, "CapacityProvider", {
    //   capacityProviderName: "CapacityForT2micro",
    //   autoScalingGroup,
    // });
    // cluster.addAsgCapacityProvider(capacityProvider);

    // addAsgCapacityProvider 推奨
    cluster.addCapacity('DefaultAutoScalingGroup', {
      instanceType: new ec2.InstanceType('t2.small'),
      spotInstanceDraining: true, // Spotインスタンスの利用設定
      spotPrice: '1.0',
      machineImageType: ecs.MachineImageType.AMAZON_LINUX_2,
      maxCapacity: 2,
      minCapacity: 1,
    })

    // ECS Task Definition
    const taskDefinition = new ecs.Ec2TaskDefinition(this, 'TaskDefinition', {
      networkMode: ecs.NetworkMode.AWS_VPC,
    })

    const container = taskDefinition.addContainer('Container', {
      image: ecs.ContainerImage.fromRegistry('amazon/amazon-ecs-sample'),
      // image: ecs.ContainerImage.fromEcrRepository(repository), // TODO
      memoryLimitMiB: 256,
      cpu: 256,
      // TODO
      // environment: {
      //   DB_HOST: postgresql.instanceEndpoint.hostname,
      //   DB_PORT: String(postgresql.instanceEndpoint.port),
      //   DB_NAME: 'ecs_deploy_sample',
      //   DB_USER: databaseCredentialSecret.secretValueFromJson('username').unsafeUnwrap(),
      //   APP_DATABASE_PASSWORD: databaseCredentialSecret.secretValueFromJson('password').unsafeUnwrap(),
      // },
    })

    container.addPortMappings({
      hostPort: 80,
      containerPort: 80,
      // hostPort: 3000, // TODO
      // containerPort: 3000, // TODO
      protocol: ecs.Protocol.TCP,
    })

    // ECS Service
    // vpcSubnets?: プライベート、アイソレート、パブリックの順で最初に利用可能なもの
    const service = new ecs.Ec2Service(this, 'Service', {
      cluster,
      taskDefinition,
      securityGroups: [securityGroupAPP],
    })
    service.attachToApplicationTargetGroup(targetGroup)
  }
}