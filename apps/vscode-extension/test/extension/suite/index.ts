import * as assert from 'node:assert';
import * as vscode from 'vscode';
import type { LocalShareExtensionApi } from '../../../src/extension';

export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension<LocalShareExtensionApi>('localshare.localshare-vscode');
  assert.ok(ext, 'Extension localshare.localshare-vscode should be present');
  const api = await ext.activate();
  assert.ok(api, 'Extension should return its public API on activate');

  const commands = await vscode.commands.getCommands(true);
  const requiredCommands = [
    'localshare.startSharing',
    'localshare.shareCustomPort',
    'localshare.refreshServers',
    'localshare.stopShare',
    'localshare.stopAllShares',
    'localshare.restartShare',
    'localshare.copyUrl',
    'localshare.openUrl',
    'localshare.copyCustomerMessage',
    'localshare.setPassword',
    'localshare.installCloudflared',
    'localshare.runDiagnostics',
    'localshare.connectCloudflare',
    'localshare.addCustomDomain',
    'localshare.verifyCustomDomain',
  ];

  for (const cmd of requiredCommands) {
    assert.ok(commands.includes(cmd), `Expected command "${cmd}" to be registered`);
  }

  const state = api.getViewState();
  assert.ok(Array.isArray(state.servers), 'ViewState should expose servers list');
  assert.ok(Array.isArray(state.shares), 'ViewState should expose shares list');
}

