import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { Provider } from "@pulumi/kubernetes/provider";

export interface NginxPlusWebsiteArgs{
    k8sProvider: Provider;
}

export class NginxPlusWebsite extends pulumi.ComponentResource {
    public readonly serviceName: pulumi.Output<string>;

    constructor(name: string, args: NginxPlusWebsiteArgs, opts?: pulumi.ComponentResourceOptions) {
        super("pulumi-azure-k8s:index:NginxPlusWebsite", name, args, opts);

        const indexConfig = new k8s.core.v1.ConfigMap("nginx-config", {
            data: {
                "index.html": `
                    <!DOCTYPE html>
                    <html>
                    <head>
                        <title>hello this is website</title>
                    </head>

                    <body>
                        <h1>Hi website kubez!</h1>
                        <br>
                        <img src="https://upload.wikimedia.org/wikipedia/commons/8/85/Smiley.svg">
                    </body>
                    </html>
                    `
            }
        }, { provider: args.k8sProvider });

        const appLabels = { app: "nginx" };
        const deployment = new k8s.apps.v1.Deployment("nginx-deployment", {
            spec: {
                selector: { matchLabels: appLabels },
                replicas: 3,
                template: {
                    metadata: { labels: appLabels },
                    spec: { 
                        containers: [{ 
                            name: "nginx", 
                            image: "nginx", 
                            ports: [{ containerPort: 80 }],
                            volumeMounts: [{
                                name: "config-volume",
                                mountPath: "/usr/share/nginx/html"
                            }]
                        }],
                        volumes: [{
                            name: "config-volume",
                            configMap: { name: indexConfig.metadata.name }
                        }]
                    }
                },
            }
        }, { provider: args.k8sProvider });

        const service = new k8s.core.v1.Service("nginx-service", {
            spec: {
                    type: "LoadBalancer",
                    ports: [{
                    port: 80,
                    protocol: "TCP",
                    targetPort: 80
                }],
                selector: appLabels
            }
        }, { provider: args.k8sProvider });
            
        this.serviceName = service.metadata.name;
    }
}