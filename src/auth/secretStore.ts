import * as vscode from 'vscode';

const SECRET_KEY = 'harness.apiKey';

export class SecretStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async getApiKey(): Promise<string | undefined> {
    const key = await this.secrets.get(SECRET_KEY);
    return key?.trim() || undefined;
  }

  async setApiKey(key: string): Promise<void> {
    await this.secrets.store(SECRET_KEY, key);
  }

  async deleteApiKey(): Promise<void> {
    await this.secrets.delete(SECRET_KEY);
  }

  async hasApiKey(): Promise<boolean> {
    const key = await this.secrets.get(SECRET_KEY);
    return !!key && key.trim().length > 0;
  }

  onDidChange(handler: () => void): vscode.Disposable {
    return this.secrets.onDidChange(e => {
      if (e.key === SECRET_KEY) handler();
    });
  }
}
