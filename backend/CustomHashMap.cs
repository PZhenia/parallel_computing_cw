namespace ParallelSearch.Server;

internal sealed class CustomHashMap<TValue> where TValue : class
{
    private const int LockCount = 256;
    private const double LoadFactor = 0.75;

    private sealed record Entry(string Key, TValue Value, Entry? Next);

    private Entry?[] _buckets = new Entry?[1024];
    private readonly object[] _locks = Enumerable.Range(0, LockCount).Select(_ => new object()).ToArray();
    private int _keyCount;

    public TValue GetOrCreate(string key, Func<TValue> valueFactory)
    {
        var buckets = Volatile.Read(ref _buckets);
        var index = BucketIndex(key, buckets.Length);
        var existing = Find(Volatile.Read(ref buckets[index]), key);
        if (existing is not null)
        {
            return existing.Value;
        }

        var created = false;
        TValue value;
        lock (_locks[index & (LockCount - 1)])
        {
            buckets = Volatile.Read(ref _buckets);
            index = BucketIndex(key, buckets.Length);
            existing = Find(Volatile.Read(ref buckets[index]), key);
            if (existing is not null)
            {
                return existing.Value;
            }

            value = valueFactory();
            Volatile.Write(ref buckets[index], new Entry(key, value, Volatile.Read(ref buckets[index])));
            Interlocked.Increment(ref _keyCount);
            created = true;
        }

        if (created && Volatile.Read(ref _keyCount) >= buckets.Length * LoadFactor)
        {
            Resize();
        }

        return value;
    }

    public TValue? Get(string key)
    {
        var buckets = Volatile.Read(ref _buckets);
        var index = BucketIndex(key, buckets.Length);
        var found = Find(Volatile.Read(ref buckets[index]), key);
        if (found is not null)
        {
            return found.Value;
        }

        var currentBuckets = Volatile.Read(ref _buckets);
        if (!ReferenceEquals(buckets, currentBuckets))
        {
            index = BucketIndex(key, currentBuckets.Length);
            found = Find(Volatile.Read(ref currentBuckets[index]), key);
        }

        return found?.Value;
    }

    public int Size => Volatile.Read(ref _keyCount);

    private void Resize()
    {
        foreach (var gate in _locks)
        {
            Monitor.Enter(gate);
        }

        try
        {
            var oldBuckets = Volatile.Read(ref _buckets);
            if (_keyCount < oldBuckets.Length * LoadFactor ||
                oldBuckets.Length >= 1 << 30)
            {
                return;
            }

            var newBuckets = new Entry?[oldBuckets.Length << 1];
            for (var i = 0; i < oldBuckets.Length; i++)
            {
                for (var current = Volatile.Read(ref oldBuckets[i]); current is not null; current = current.Next)
                {
                    var newIndex = BucketIndex(current.Key, newBuckets.Length);
                    newBuckets[newIndex] = new Entry(current.Key, current.Value, newBuckets[newIndex]);
                }
            }

            Volatile.Write(ref _buckets, newBuckets);
        }
        finally
        {
            for (var i = _locks.Length - 1; i >= 0; i--)
            {
                Monitor.Exit(_locks[i]);
            }
        }
    }

    private static Entry? Find(Entry? head, string key)
    {
        for (var current = head; current is not null; current = current.Next)
        {
            if (StringComparer.Ordinal.Equals(current.Key, key))
            {
                return current;
            }
        }

        return null;
    }

    private static int BucketIndex(string key, int capacity)
    {
        var hash = key.GetHashCode(StringComparison.Ordinal);
        hash ^= (int)((uint)hash >> 16);
        return hash & (capacity - 1);
    }
}
