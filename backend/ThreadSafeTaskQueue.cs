namespace ParallelSearch.Server;

internal sealed class ThreadSafeTaskQueue<T>
{
    private readonly object _gate = new();
    private readonly Queue<T> _items = new();
    private bool _completed;

    public void Enqueue(T item)
    {
        lock (_gate)
        {
            ObjectDisposedException.ThrowIf(_completed, this);
            _items.Enqueue(item);
            Monitor.Pulse(_gate);
        }
    }

    public bool TryTake(out T? item)
    {
        lock (_gate)
        {
            while (_items.Count == 0 && !_completed)
            {
                Monitor.Wait(_gate);
            }

            if (_items.Count == 0)
            {
                item = default;
                return false;
            }

            item = _items.Dequeue();
            return true;
        }
    }

    public void CompleteAdding()
    {
        lock (_gate)
        {
            _completed = true;
            Monitor.PulseAll(_gate);
        }
    }
}
