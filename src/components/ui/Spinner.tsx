interface SpinnerProps {
  size?: 'sm' | 'md' | 'lg';
}

const sizeClasses = {
  sm: 'h-4 w-4 border-2',
  md: 'h-8 w-8 border-3',
  lg: 'h-12 w-12 border-4',
} as const;

export default function Spinner({ size = 'md' }: SpinnerProps) {
  return (
    <div className="flex items-center justify-center">
      <div
        className={`${sizeClasses[size]} animate-spin rounded-full border-indigo-500 border-t-transparent`}
      />
    </div>
  );
}
