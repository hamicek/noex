<script lang="ts">
  let count = $state(0);
</script>

<main>
  <h1>noex Web Dashboard</h1>
  <p>Dashboard is loading... (count: {count})</p>
  <button onclick={() => count++}>Increment</button>
</main>

<style>
  main {
    font-family: system-ui, -apple-system, sans-serif;
    padding: 2rem;
    text-align: center;
  }

  h1 {
    color: var(--color-primary, #007acc);
  }

  button {
    padding: 0.5rem 1rem;
    font-size: 1rem;
    cursor: pointer;
  }
</style>
