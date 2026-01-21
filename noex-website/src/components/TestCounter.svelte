<script lang="ts">
  let count = $state(0);

  function increment() {
    count++;
  }
</script>

<div class="flex items-center gap-4 p-4 rounded-lg bg-bg-card border border-border">
  <span class="text-text-secondary">Test Counter:</span>
  <span class="text-2xl font-mono text-accent-primary">{count}</span>
  <button
    onclick={increment}
    class="px-4 py-2 bg-accent-primary text-bg-primary font-semibold rounded hover:opacity-90 transition-opacity"
  >
    Increment
  </button>
</div>
