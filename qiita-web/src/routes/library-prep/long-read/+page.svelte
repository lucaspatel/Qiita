<script lang="ts">
  // MOCKUP of the long-read (PacBio Revio) amplicon branch of Library prep. The pool
  // is multiplexed with PacBio barcodes and demultiplexed upstream in SMRTlink, so
  // there are no plates and no Golay step: the prep is a barcode→sample map (Serena's
  // file) plus the run's protocol facts. Unlike the short-read flow it does NOT build
  // a pre-prep sheet to launder — it collects the pre-flight's native fields and (in
  // the real flow) posts them to the control plane, which calls kl-run-preflight's
  // typed builders to author the pre-flight directly. Local data only; nothing sent.
  import {
    DEMO_POOL,
    DEMO_RUN,
    OTHER,
    PROTOCOL_FULL_16S,
    STUDIES,
    builderPreview,
    poolProblems,
    type PoolSample,
    type Protocol,
    type RunFacts
  } from '$lib/libraryPrep/longRead';

  const STEPS = ['Protocol', 'Pool', 'Barcodes', 'Details', 'Pre-flight', 'Sequence'];
  let step = $state(0);
  let reached = $state(0);
  const go = (i: number) => {
    step = i;
    reached = Math.max(reached, i);
  };
  const pretty = (s: string) => s.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase());
  const titleOf = (k: string) => (k === OTHER ? 'Not in Qiita-miint' : (STUDIES[k]?.title ?? k));
  const colorOf = (k: string) => (k === OTHER ? '#9ca3af' : (STUDIES[k]?.color ?? '#9ca3af'));

  // --- 1. protocol ---
  const PROTOCOL = 'long_read_amplicon';
  const PRIMER_SETS = [
    { id: 'full_16s', label: 'Full-length 16S · 27F / 1492R (UMI-tagged)', enabled: true },
    { id: 'full_18s', label: 'Full-length 18S — not yet', enabled: false }
  ];
  let primerSet = $state<string | null>(null);

  // --- 2. pool: the barcode→sample map ---
  let pool = $state<PoolSample[]>([]);
  const loadDemo = () => (pool = DEMO_POOL.map((s) => ({ ...s })));
  const scanned = $derived(pool.length > 0);

  // --- 3. barcodes: validate the demux map ---
  const problems = $derived(poolProblems(pool));

  // --- 4. details: protocol + run facts ---
  let protocol = $state<Protocol>({ ...PROTOCOL_FULL_16S });
  let run = $state<RunFacts>({ ...DEMO_RUN });

  // --- 5. pre-flight: authored directly via typed builders ---
  let built = $state(false);
  const preflightName = $derived(
    run.movie_context ? `${run.movie_context}.preflight.db` : 'run.preflight.db'
  );
  const preview = $derived(builderPreview(pool, protocol, run));

  // --- 6. sequence ---
  let started = $state(false);

  const canLeave = $derived([
    primerSet !== null, // protocol
    scanned, // pool
    problems.length === 0, // barcodes
    !!(protocol.fwd_primer && protocol.rev_primer && protocol.umi_pattern), // details
    built, // pre-flight
    true // sequence
  ]);

  const select =
    'col-start-1 row-start-1 w-full appearance-none rounded-md bg-white py-1.5 pr-8 pl-3 text-base text-gray-900 outline-1 -outline-offset-1 outline-gray-300 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-teal-600 sm:text-sm/6';
  const field =
    'block w-full rounded-md bg-white px-3 py-1.5 text-base text-gray-900 outline-1 -outline-offset-1 outline-gray-300 focus:outline-2 focus:-outline-offset-2 focus:outline-teal-600 sm:text-sm/6';
</script>

{#snippet chevron()}
  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" class="pointer-events-none col-start-1 row-start-1 mr-2 size-5 self-center justify-self-end text-gray-500 sm:size-4"><path d="M4.22 6.22a.75.75 0 0 1 1.06 0L8 8.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.28a.75.75 0 0 1 0-1.06Z" clip-rule="evenodd" fill-rule="evenodd" /></svg>
{/snippet}

{#snippet labeled(label: string, value: string, set: (v: string) => void, mono = false)}
  <label class="block">
    <span class="block text-sm/6 font-medium text-gray-900">{label}</span>
    <input class="{field} {mono ? 'font-mono text-xs' : ''}" value={value} oninput={(e) => set(e.currentTarget.value)} />
  </label>
{/snippet}

<div class="mb-6">
  <div class="flex items-center justify-between gap-3">
    <h1 class="text-2xl/7 font-bold text-gray-900">Library prep · long-read amplicon</h1>
    <a href="/library-prep" class="text-sm font-medium text-teal-700 hover:text-teal-600">← short-read flow</a>
  </div>
  <p class="mt-1 text-sm text-gray-500">A multiplexed PacBio (Revio) 16S pool, from its barcode map to a running ingest.</p>
</div>

<!-- Steps (Tailwind UI: navigation / progress bars / panels) -->
<nav aria-label="Progress" class="mb-6">
  <ol role="list" class="divide-y divide-gray-300 rounded-md border border-gray-300 bg-white md:flex md:divide-y-0">
    {#each STEPS as label, i}
      <li class="relative md:flex md:flex-1">
        <button type="button" disabled={i > reached} aria-current={i === step ? 'step' : undefined} class="group flex w-full items-center px-4 py-3 text-sm font-medium disabled:cursor-not-allowed" onclick={() => go(i)}>
          {#if i < step}
            <span class="flex size-8 shrink-0 items-center justify-center rounded-full bg-teal-600 group-hover:bg-teal-800">
              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" class="size-5 text-white"><path d="M19.916 4.626a.75.75 0 0 1 .208 1.04l-9 13.5a.75.75 0 0 1-1.154.114l-6-6a.75.75 0 0 1 1.06-1.06l5.353 5.353 8.493-12.74a.75.75 0 0 1 1.04-.207Z" clip-rule="evenodd" fill-rule="evenodd" /></svg>
            </span>
            <span class="ml-3 whitespace-nowrap text-gray-900">{label}</span>
          {:else if i === step}
            <span class="flex size-8 shrink-0 items-center justify-center rounded-full border-2 border-teal-600 text-teal-600">{i + 1}</span>
            <span class="ml-3 whitespace-nowrap text-teal-700">{label}</span>
          {:else}
            <span class="flex size-8 shrink-0 items-center justify-center rounded-full border-2 border-gray-300 text-gray-500">{i + 1}</span>
            <span class="ml-3 whitespace-nowrap text-gray-500">{label}</span>
          {/if}
        </button>
        {#if i < STEPS.length - 1}
          <div aria-hidden="true" class="absolute top-0 right-0 hidden h-full w-4 md:block">
            <svg viewBox="0 0 22 80" fill="none" preserveAspectRatio="none" class="size-full text-gray-300"><path d="M0 -2L20 40L0 82" stroke="currentcolor" vector-effect="non-scaling-stroke" stroke-linejoin="round" /></svg>
          </div>
        {/if}
      </li>
    {/each}
  </ol>
</nav>

<div class="rounded-lg bg-white px-4 py-5 shadow-sm ring-1 ring-gray-900/5 sm:p-6">
  {#if step === 0}
    <div class="grid max-w-3xl grid-cols-1 gap-4 sm:grid-cols-2">
      <div>
        <label for="protocol" class="block text-sm/6 font-semibold text-gray-900">Prep protocol</label>
        <div class="mt-2 grid grid-cols-1">
          <select id="protocol" class={select} disabled>
            <option>{pretty(PROTOCOL)}</option>
          </select>
          {@render chevron()}
        </div>
        <p class="mt-1 text-xs text-gray-500">PacBio Revio, 16S full-length amplicon.</p>
      </div>
      <div>
        <label for="primers" class="block text-sm/6 font-semibold text-gray-900">Primers</label>
        <div class="mt-2 grid grid-cols-1">
          <select id="primers" bind:value={primerSet} class={select}>
            <option value={null} disabled>Choose primers…</option>
            {#each PRIMER_SETS as p (p.id)}
              <option value={p.id} disabled={!p.enabled}>{p.label}</option>
            {/each}
          </select>
          {@render chevron()}
        </div>
      </div>
    </div>
  {:else if step === 1}
    <h2 class="text-sm/6 font-semibold text-gray-900">The pool</h2>
    <p class="mt-1 text-sm text-gray-500">
      The barcode map from the bench: one PacBio barcode per sample, demultiplexed upstream in SMRTlink. Each tube
      is checked against Qiita-miint as it lands — a tube may repeat as a technical replicate.
    </p>
    {#if !scanned}
      <div class="mt-4 rounded-lg border-2 border-dashed border-gray-300 p-8 text-center">
        <p class="text-sm font-semibold text-gray-900">Drop the barcode map, or</p>
        <p class="mt-1 text-xs text-gray-500">
          <button type="button" class="font-medium text-teal-700 hover:text-teal-600" onclick={loadDemo}>use the demo pool</button>
        </p>
      </div>
    {:else}
      <ul role="list" class="mt-4 divide-y divide-gray-100 rounded-md border border-gray-200 text-sm">
        {#each pool as s (s.sample_name)}
          <li class="flex flex-wrap items-center gap-3 px-4 py-2">
            <span class="size-2.5 rounded-full" style="background:{colorOf(s.study ?? OTHER)}"></span>
            <span class="font-medium text-gray-900">{s.sample_name}</span>
            <span class="font-mono text-xs text-gray-500">{s.barcode_id}</span>
            <span class="font-mono text-xs text-gray-400">tube {s.tube}</span>
            {#if s.sample_type === 'control'}<span class="rounded bg-gray-100 px-1.5 text-xs text-gray-600">blank</span>{/if}
            <span class="ml-auto text-xs text-gray-500">{titleOf(s.study ?? OTHER)}</span>
          </li>
        {/each}
      </ul>
      <p class="mt-3 text-sm text-gray-600">{pool.length} samples · {new Set(pool.map((s) => s.study)).size} studies.</p>
    {/if}
  {:else if step === 2}
    <h2 class="text-sm/6 font-semibold text-gray-900">Barcodes</h2>
    <p class="mt-1 text-sm text-gray-500">Each PacBio barcode must demultiplex exactly one sample. No Golay, no plate map — the demux is upstream.</p>
    <ul role="list" class="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
      {#each pool as s (s.sample_name)}
        <li class="flex items-center gap-2 rounded-md border border-gray-200 px-3 py-2 text-sm">
          <span class="font-mono text-xs text-gray-900">{s.barcode_id}</span>
          <span class="ml-auto truncate text-xs text-gray-500">{s.sample_name}</span>
        </li>
      {/each}
    </ul>
    {#if problems.length}
      <ul class="mt-4 space-y-1 text-sm text-red-700">{#each problems as t}<li>{t}</li>{/each}</ul>
    {:else}
      <p class="mt-4 text-sm text-gray-600">{pool.length} barcodes, each demultiplexing one sample.</p>
    {/if}
  {:else if step === 3}
    <h2 class="text-sm/6 font-semibold text-gray-900">Protocol & run details</h2>
    <p class="mt-1 text-sm text-gray-500">
      The only per-run facts the pre-flight needs beyond a normal PacBio run: the primers, the UMI pattern, and the
      target region. Everything downstream (quality/length cutoffs, clustering, variant support) is processing config,
      not pre-flight.
    </p>
    <div class="mt-4 grid max-w-3xl grid-cols-1 gap-4 sm:grid-cols-2">
      {@render labeled('Forward primer (27F)', protocol.fwd_primer, (v) => (protocol.fwd_primer = v), true)}
      {@render labeled('Reverse primer (1492R)', protocol.rev_primer, (v) => (protocol.rev_primer = v), true)}
      {@render labeled("5' construct primer", protocol.five_prime_primer, (v) => (protocol.five_prime_primer = v), true)}
      {@render labeled("3' construct primer", protocol.three_prime_primer, (v) => (protocol.three_prime_primer = v), true)}
      {@render labeled('UMI pattern', protocol.umi_pattern, (v) => (protocol.umi_pattern = v), true)}
      {@render labeled('Target subfragment', protocol.target_subfragment, (v) => (protocol.target_subfragment = v))}
    </div>
    <h3 class="mt-6 text-sm font-medium text-gray-900">Revio run</h3>
    <div class="mt-2 grid max-w-3xl grid-cols-1 gap-4 sm:grid-cols-2">
      {@render labeled('Instrument', run.instrument_model, (v) => (run.instrument_model = v))}
      {@render labeled('SMRT cell well', run.smrt_cell_well, (v) => (run.smrt_cell_well = v), true)}
      {@render labeled('Movie context', run.movie_context, (v) => (run.movie_context = v), true)}
      <label class="block">
        <span class="block text-sm/6 font-medium text-gray-900">Run date</span>
        <input type="date" class={field} bind:value={run.run_date} />
      </label>
    </div>
  {:else if step === 4}
    <h2 class="text-sm/6 font-semibold text-gray-900">Build the pre-flight</h2>
    <p class="mt-1 text-sm text-gray-500">
      Authored <span class="font-medium text-gray-700">directly</span> — no pre-prep sheet to launder. The control
      plane calls kl-run-preflight's typed builders with these fields and stores the pre-flight blob the ingest submits with.
    </p>
    <details class="mt-4" open>
      <summary class="cursor-pointer text-xs text-teal-700">The builder calls the server would make</summary>
      <pre class="mt-2 max-h-80 overflow-auto rounded bg-gray-50 p-3 text-[11px] leading-4">{preview}</pre>
    </details>
    {#if built}
      <div class="mt-4 rounded-md bg-green-50 p-4">
        <h3 class="text-sm font-medium text-green-800">Pre-flight ready</h3>
        <p class="mt-2 text-sm text-green-700">kl-run-preflight authored <span class="font-mono text-xs">{preflightName}</span> from {pool.length} samples. The sequencing step submits with it.</p>
        <div class="mt-3 -mx-2 -my-1.5 flex">
          <button type="button" class="rounded-md bg-green-50 px-2 py-1.5 text-sm font-medium text-green-800 hover:bg-green-100 disabled:opacity-50" disabled title="Authored by kl-run-preflight on the server in the real flow">Download {preflightName}</button>
        </div>
      </div>
    {/if}
  {:else if step === 5}
    <h2 class="text-sm/6 font-semibold text-gray-900">Sequence</h2>
    <p class="mt-1 text-sm text-gray-500">The pool is already demultiplexed (SMRTlink), so ingest loads one BAM per barcode — the existing PacBio path.</p>
    <div class="mt-4">
      {#if !started}
        <button type="button" class="rounded-md bg-teal-600 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-teal-500" onclick={() => (started = true)}>Start PacBio ingest</button>
      {:else}
        <ol class="space-y-2 text-sm">
          <li class="flex items-center gap-2"><span class="size-2 rounded-full bg-blue-500"></span>pacbio-ingest — queued with {preflightName}: {pool.length} per-barcode BAMs fan out to bam-to-parquet</li>
          <li class="flex items-center gap-2"><span class="size-2 rounded-full bg-gray-300"></span>rrna-operon — UMI detection, dechimera, clustering (processing, not yet wired into Qiita)</li>
        </ol>
      {/if}
    </div>
  {/if}

  <div class="mt-8 flex items-center justify-between border-t border-gray-100 pt-4">
    <button type="button" class="rounded-md bg-white px-3 py-2 text-sm font-semibold text-gray-900 shadow-xs ring-1 ring-gray-300 ring-inset hover:bg-gray-50 disabled:invisible" disabled={step === 0} onclick={() => go(step - 1)}>Back</button>
    {#if step < STEPS.length - 1}
      {#if step === 4 && !built}
        <button type="button" class="rounded-md bg-teal-600 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-teal-500 disabled:opacity-40" disabled={problems.length > 0} onclick={() => (built = true)}>Build pre-flight</button>
      {:else}
        <button type="button" class="rounded-md bg-teal-600 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-teal-500 disabled:opacity-40" disabled={!canLeave[step]} onclick={() => go(step + 1)}>Next: {STEPS[step + 1]}</button>
      {/if}
    {/if}
  </div>
</div>
