<script lang="ts">
import type { Snippet } from 'svelte';

type Variant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'destructive';
type Size = 'sm' | 'md' | 'icon';

interface Props {
  children: Snippet;
  variant?: Variant;
  size?: Size;
  type?: 'button' | 'submit' | 'reset';
  disabled?: boolean;
  ariaLabel?: string;
  ariaDescribedby?: string;
  class?: string;
  onclick?: (event: MouseEvent) => void;
  element?: HTMLButtonElement | undefined;
}

let {
  children,
  variant = 'secondary',
  size = 'md',
  type = 'button',
  disabled = false,
  ariaLabel,
  ariaDescribedby,
  class: className = '',
  onclick,
  element = $bindable()
}: Props = $props();

const variants: Record<Variant, string> = {
  primary: 'border-primary bg-primary text-primary-foreground hover:brightness-95',
  secondary:
    'border-border bg-secondary text-secondary-foreground hover:bg-accent hover:text-accent-foreground',
  outline: 'border-border bg-background text-foreground hover:bg-muted',
  ghost: 'border-transparent bg-transparent text-foreground shadow-none hover:bg-muted',
  destructive: 'border-destructive bg-destructive text-destructive-foreground hover:brightness-95'
};

const sizes: Record<Size, string> = {
  sm: 'min-h-8 px-2.5 text-xs',
  md: 'min-h-9 px-3.5 text-sm',
  icon: 'size-9 p-0'
};

let classes = $derived(
  `focus-ring inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius)] border font-semibold shadow-[var(--shadow-xs)] transition-colors disabled:pointer-events-none disabled:opacity-50 ${variants[variant]} ${sizes[size]} ${className}`
);
</script>

<button
  bind:this={element}
  {type}
  {disabled}
  aria-label={ariaLabel}
  aria-describedby={ariaDescribedby}
  class={classes}
  {onclick}
>
  {@render children()}
</button>
