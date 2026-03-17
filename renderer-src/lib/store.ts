import { useSyncExternalStore } from 'react';

type Listener = () => void;

export function createStore<TState>(initialState: TState) {
  let state = initialState;
  const listeners = new Set<Listener>();

  return {
    getState() {
      return state;
    },
    setState(nextState: TState) {
      state = nextState;
      listeners.forEach((listener) => listener());
    },
    update(updater: (current: TState) => TState) {
      state = updater(state);
      listeners.forEach((listener) => listener());
    },
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function useStoreValue<TState>(store: { getState: () => TState; subscribe: (listener: Listener) => () => void }) {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}
