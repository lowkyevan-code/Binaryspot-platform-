import './globals.css';

export const metadata = {
  title: 'BinarySpot Engine',
  description: 'Deriv Automated Trading Platform',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
