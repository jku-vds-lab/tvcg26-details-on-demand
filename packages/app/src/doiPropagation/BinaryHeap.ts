/**
 * BinaryHeap.ts
 * A simple binary heap implementation for objects with a key.
 */

export class BinaryHeap<T> {
    private heap: T[];
    private comparator: (a: T, b: T) => number;
  
    constructor(comparator: (a: T, b: T) => number) {
      this.heap = [];
      this.comparator = comparator;
    }
  
    public isEmpty(): boolean {
      return this.heap.length === 0;
    }
  
    public insert(item: T): void {
      this.heap.push(item);
      this.bubbleUp(this.heap.length - 1);
    }
  
    public extractMax(): T | null {
      if (this.isEmpty()) return null;
      const max = this.heap[0];
      const end = this.heap.pop();
      if (this.heap.length > 0 && end !== undefined) {
        this.heap[0] = end;
        this.sinkDown(0);
      }
      return max;
    }
  
    private bubbleUp(n: number): void {
      const element = this.heap[n];
      while (n > 0) {
        const parentN = Math.floor((n - 1) / 2);
        const parent = this.heap[parentN];
        if (this.comparator(element, parent) <= 0) break;
        this.heap[parentN] = element;
        this.heap[n] = parent;
        n = parentN;
      }
    }
  
    private sinkDown(n: number): void {
      const length = this.heap.length;
      const element = this.heap[n];
  
      while (true) {
        const leftChildN = 2 * n + 1;
        const rightChildN = 2 * n + 2;
        let swap = -1;
  
        if (leftChildN < length) {
          const leftChild = this.heap[leftChildN];
          if (this.comparator(leftChild, element) > 0) {
            swap = leftChildN;
          }
        }
  
        if (rightChildN < length) {
          const rightChild = this.heap[rightChildN];
          if (
            (swap === -1 && this.comparator(rightChild, element) > 0) ||
            (swap !== -1 && this.comparator(rightChild, this.heap[swap]) > 0)
          ) {
            swap = rightChildN;
          }
        }
  
        if (swap === -1) break;
        this.heap[n] = this.heap[swap];
        this.heap[swap] = element;
        n = swap;
      }
    }
  }
  