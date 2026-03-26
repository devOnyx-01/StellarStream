import { Horizon } from '@stellar/stellar-sdk';
import NodeCache from 'node-cache';

interface TokenMetadata {
  code: string;
  issuer?: string;
  decimals: number;
  symbol: string;
}

export class TokenMetadataService {
  private cache: NodeCache;
  private horizon: Horizon.Server;

  constructor(horizonUrl: string = 'https://horizon-testnet.stellar.org', ttl: number = 86400) {
    this.cache = new NodeCache({ stdTTL: ttl });
    this.horizon = new Horizon.Server(horizonUrl);
  }

  async getTokenMetadata(contractId: string): Promise<TokenMetadata> {
    const cached = this.cache.get<TokenMetadata>(contractId);
    if (cached) return cached;

    const metadata = await this.fetchFromHorizon(contractId);
    this.cache.set(contractId, metadata);
    return metadata;
  }

  private async fetchFromHorizon(contractId: string): Promise<TokenMetadata> {
    try {
      const account = await this.horizon.accounts().accountId(contractId).call();
      
      // Extract asset info from account data
      const assetCode = account.home_domain || this.extractAssetCode(account);
      const decimals = 7; // Default Stellar decimals
      
      return {
        code: assetCode,
        issuer: contractId,
        decimals,
        symbol: assetCode
      };
    } catch (error) {
      // Fallback: parse contract ID or return generic
      return {
        code: this.parseContractId(contractId),
        decimals: 7,
        symbol: this.parseContractId(contractId)
      };
    }
  }

  private extractAssetCode(account: any): string {
    // Try to extract from balances
    if (account.balances?.length > 0) {
      const asset = account.balances.find((b: any) => b.asset_type !== 'native');
      if (asset?.asset_code) return asset.asset_code;
    }
    return 'UNKNOWN';
  }

  private parseContractId(contractId: string): string {
    // Extract last 4 chars as fallback identifier
    return contractId.slice(-4).toUpperCase();
  }

  clearCache(): void {
    this.cache.flushAll();
  }
}
