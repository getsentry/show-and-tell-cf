import '@testing-library/jest-dom/vitest';
import {render, screen} from '@testing-library/react';
import {describe, expect, it} from 'vitest';

import {App} from '../../src/app/App';

describe('App', () => {
  it('introduces the Show & Tell application', () => {
    render(<App />);
    expect(screen.getByRole('heading', {name: 'Show & Tell'})).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Foundation online');
  });
});
