import * as pulumi from "@pulumi/pulumi";
import * as resources from "@pulumi/azure-native/resources";
import * as network from "@pulumi/azure-native/network";
import * as containerservice from "@pulumi/azure-native/containerservice";
import * as storage from "@pulumi/azure-native/storage"
import * as k8s from "@pulumi/kubernetes";
import { NginxPlusWebsite } from "./components/nginx-n-website";
import * as argocd from "@three14/pulumi-argocd";
import { password } from "@three14/pulumi-argocd/config";

// Grab some values from the Pulumi stack configuration (or use defaults)
const projCfg = new pulumi.Config();
const numWorkerNodes = projCfg.getNumber("numWorkerNodes") || 3;
const k8sVersion = projCfg.get("kubernetesVersion") || "1.36";
const prefixForDns = projCfg.get("prefixForDns") || "pulumi";
const nodeVmSize = projCfg.get("nodeVmSize") || "Standard_DS2_v2";
// The next two configuration values are required (no default can be provided)
const mgmtGroupId = projCfg.require("mgmtGroupId");
const sshPubKey = projCfg.require("sshPubKey");

// Create a new Azure Resource Group
const resourceGroup = new resources.ResourceGroup("resourceGroup", {});

// ------------ Creating a storage account ------------

const storageAccount = new storage.StorageAccount("pulumiStateStorage", {
    kind: storage.Kind.StorageV2,
    resourceGroupName: resourceGroup.name,
    sku: {
        name: storage.SkuName.Standard_GRS //GRS is a type of BlobStorage
    },
    accessTier: storage.AccessTier.Hot,
    accountName: "paulscoolpulumistorage",
    allowBlobPublicAccess: false,
    allowSharedKeyAccess: true,
});

const encryptionScope = new storage.EncryptionScope("encryptionScope", {
    accountName: storageAccount.name,
    resourceGroupName: resourceGroup.name,
    encryptionScopeName: "pulumiencryptionscope",
    source: "Microsoft.Storage"
})

const storageContainer = new storage.BlobContainer("pulumiStateContainer", {
    accountName: storageAccount.name,
    resourceGroupName: resourceGroup.name,
    containerName: "paulscoolpulumicontainer",
    defaultEncryptionScope: encryptionScope.name,
    denyEncryptionScopeOverride: true,
}, { dependsOn: encryptionScope });

const storageBlob = new storage.Blob("pulumiStateBlob", {
    accountName: storageAccount.name,
    resourceGroupName: resourceGroup.name,
    containerName: storageContainer.name,
    blobName: "paulscoolpulumiblob",
    accessTier: storage.BlobAccessTier.Hot,
})

// ------------ Creating K8s resources ------------

// Create a new Azure Virtual Network
const virtualNetwork = new network.VirtualNetwork("virtualNetwork", {
    addressSpace: {
        addressPrefixes: ["10.0.0.0/16"],
    },
    resourceGroupName: resourceGroup.name,
});

// Create three subnets in the virtual network
const subnet1 = new network.Subnet("subnet1", {
    addressPrefix: "10.0.0.0/22",
    resourceGroupName: resourceGroup.name,
    virtualNetworkName: virtualNetwork.name,
});

const subnet2 = new network.Subnet("subnet2", {
    addressPrefix: "10.0.4.0/22",
    resourceGroupName: resourceGroup.name,
    virtualNetworkName: virtualNetwork.name,
});

const subnet3 = new network.Subnet("subnet3", {
    addressPrefix: "10.0.8.0/22",
    resourceGroupName: resourceGroup.name,
    virtualNetworkName: virtualNetwork.name,
});

// Create an Azure Kubernetes Cluster
const managedCluster = new containerservice.ManagedCluster("managedCluster", {
    aadProfile: {
        enableAzureRBAC: true,
        managed: true,
        adminGroupObjectIDs: [mgmtGroupId],
    },
    addonProfiles: {},
    // Use multiple agent/node pool profiles to distribute nodes across subnets
    agentPoolProfiles: [{
        //availabilityZones: [],
        count: numWorkerNodes,
        enableNodePublicIP: false,
        mode: "System",
        name: "systempool",
        osType: "Linux",
        osDiskSizeGB: 30,
        type: "VirtualMachineScaleSets",
        vmSize: nodeVmSize,
        // Change next line for additional node pools to distribute across subnets
        vnetSubnetID: subnet1.id,
    }],
    // Change authorizedIPRanges to limit access to API server
    // Changing enablePrivateCluster requires alternate access to API server (VPN or similar)
    apiServerAccessProfile: {
        authorizedIPRanges: ["0.0.0.0/0"],
        enablePrivateCluster: false,
    },
    dnsPrefix: prefixForDns,
    enableRBAC: true,
    identity: {
        type: "SystemAssigned",
    },
    kubernetesVersion: k8sVersion,
    linuxProfile: {
        adminUsername: "azureuser",
        ssh: {
            publicKeys: [{
                keyData: sshPubKey,
            }],
        },
    },
    networkProfile: {
        networkPlugin: "azure",
        networkPolicy: "azure",
        serviceCidr: "10.96.0.0/16",
        dnsServiceIP: "10.96.0.10",
    },
    resourceGroupName: resourceGroup.name,
});

// Build a user Kubeconfig
// This SHOULD NOT be used for an explicit provider
// This SHOULD be used for user logins to the cluster
const creds = containerservice.listManagedClusterUserCredentialsOutput({
    resourceGroupName: resourceGroup.name,
    resourceName: managedCluster.name,
});
const encoded = creds.kubeconfigs[0].value;
const decoded = encoded.apply(enc => Buffer.from(enc, "base64").toString());

// Build an admin Kubeconfig
// This SHOULD be used for an explicit provider
// This SHOULD NOT be used for user logins to the cluster
const adminCreds = containerservice.listManagedClusterAdminCredentialsOutput({
    resourceGroupName: resourceGroup.name,
    resourceName: managedCluster.name,
});
const adminEncoded = adminCreds.kubeconfigs[0].value;
const adminDecoded = adminEncoded.apply(enc => Buffer.from(enc, "base64").toString());

const k8sProvider = new k8s.Provider("provider", {
    kubeconfig: adminDecoded,
    cluster: managedCluster.name
});

const argoProvider = new argocd.Provider("provider", {
    username: process.env.ARGO_USERNAME,
    password: process.env.ARGO_PASSWORD
})

/*
const website = new NginxPlusWebsite("website", {
    k8sProvider: k8sProvider
})
*/

const argoNamespace = new k8s.core.v1.Namespace("argocd", {}, {provider: k8sProvider});

const argoChart = new k8s.helm.v4.Chart("argocd", {
    chart: "argo/argo-cd",
    version: "10.9.2",
    namespace: "argocd",
    values: {
        server: {
            service: {
                type: "LoadBalancer"
            }
        },
        configs: {
            secret: {
                argocdServerAdminPassword: "$2b$12$vEMX9it7kFyCI8FHsTEzHOabt3keG/sO0a0MnnJ8lgS/0B.7u/iHS" //password is helloargoloveyou
            }
        },
    },
}, { provider: k8sProvider })

// Export some values for use elsewhere
export const rgName = resourceGroup.name;
export const networkName = virtualNetwork.name;
export const clusterName = managedCluster.name;
export const kubeconfig = decoded;
//export const adminKubeconfig = pulumi.secret(adminDecoded)
