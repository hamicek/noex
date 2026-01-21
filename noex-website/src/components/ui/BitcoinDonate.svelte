<script lang="ts">
  interface Props {
    address: string;
    btcLabel: string;
    copiedLabel: string;
  }

  let { address, btcLabel, copiedLabel }: Props = $props();

  let copied = $state(false);

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(address);
      copied = true;
      setTimeout(() => {
        copied = false;
      }, 2000);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = address;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      copied = true;
      setTimeout(() => {
        copied = false;
      }, 2000);
    }
  }

  // Generate QR code URL using external API (no runtime dependencies)
  const qrCodeUrl = $derived(
    `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=bitcoin:${encodeURIComponent(address)}&bgcolor=1a1a2e&color=00ff88&format=svg`
  );

  // Truncate address for display
  const displayAddress = $derived(
    address.length > 20
      ? `${address.slice(0, 10)}...${address.slice(-8)}`
      : address
  );
</script>

<div class="bitcoin-donate">
  <div class="btc-header">
    <svg class="btc-icon" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm0 22c-5.523 0-10-4.477-10-10S6.477 2 12 2s10 4.477 10 10-4.477 10-10 10zm.5-15.5h-3v2h1v7h-1v2h5v-2h-1v-2.5h.5c1.93 0 3.5-1.57 3.5-3.5s-1.57-3-3.5-3zm0 5h-.5v-3h.5c.827 0 1.5.673 1.5 1.5s-.673 1.5-1.5 1.5z"/>
    </svg>
    <span class="btc-label">{btcLabel}</span>
  </div>

  <div class="qr-container">
    <img
      src={qrCodeUrl}
      alt="Bitcoin QR Code"
      class="qr-code"
      loading="lazy"
    />
  </div>

  <button
    class="address-container"
    onclick={copyAddress}
    aria-label={copied ? copiedLabel : `Copy Bitcoin address: ${address}`}
  >
    <code class="btc-address">{displayAddress}</code>
    <div class="copy-indicator" class:copied>
      {#if copied}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="check-icon">
          <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5" />
        </svg>
        <span class="copied-text">{copiedLabel}</span>
      {:else}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="copy-icon">
          <path stroke-linecap="round" stroke-linejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
        </svg>
      {/if}
    </div>
  </button>
</div>

<style>
  .bitcoin-donate {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
    padding: 24px;
  }

  .btc-header {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .btc-icon {
    width: 24px;
    height: 24px;
    color: #f7931a;
  }

  .btc-label {
    font-size: 1rem;
    font-weight: 600;
    color: var(--color-text-primary);
  }

  .qr-container {
    background: white;
    padding: 12px;
    border-radius: 12px;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.2);
  }

  .qr-code {
    width: 150px;
    height: 150px;
    display: block;
    border-radius: 4px;
  }

  .address-container {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 16px;
    background: rgba(247, 147, 26, 0.1);
    border: 1px solid rgba(247, 147, 26, 0.3);
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.2s ease;
    width: 100%;
    justify-content: center;
  }

  .address-container:hover {
    background: rgba(247, 147, 26, 0.15);
    border-color: rgba(247, 147, 26, 0.5);
  }

  .btc-address {
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 0.85rem;
    color: var(--color-text-secondary);
  }

  .copy-indicator {
    display: flex;
    align-items: center;
    gap: 4px;
    color: var(--color-text-secondary);
    transition: all 0.2s ease;
  }

  .copy-indicator.copied {
    color: var(--color-accent-primary);
  }

  .copy-indicator svg {
    width: 16px;
    height: 16px;
  }

  .copied-text {
    font-size: 0.75rem;
    white-space: nowrap;
  }

  @media (max-width: 768px) {
    .bitcoin-donate {
      padding: 20px 16px;
    }

    .qr-code {
      width: 120px;
      height: 120px;
    }

    .btc-address {
      font-size: 0.75rem;
    }
  }
</style>
