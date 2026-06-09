type Variant = 'red' | 'green' | 'gray' | 'yellow' | 'blue';

const styles: Record<Variant, string> = {
  red: 'bg-red-100 text-red-800',
  green: 'bg-green-100 text-green-800',
  gray: 'bg-gray-100 text-gray-700',
  yellow: 'bg-yellow-100 text-yellow-800',
  blue: 'bg-blue-100 text-blue-800',
};

export default function Badge({ children, variant = 'gray' }: { children: React.ReactNode; variant?: Variant }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${styles[variant]}`}>
      {children}
    </span>
  );
}
