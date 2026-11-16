using System.Collections;

namespace ParallelSearch.Server;

internal sealed class ConcurrentPostingList : IEnumerable<InvertedIndex.Posting>
{
    private sealed record Node(InvertedIndex.Posting Value, Node? Next);
    private Node? _head;

    public void Add(InvertedIndex.Posting posting)
    {
        Node? current;
        Node created;
        do
        {
            current = Volatile.Read(ref _head);
            created = new Node(posting, current);
        } while (!ReferenceEquals(
            Interlocked.CompareExchange(ref _head, created, current),
            current));
    }

    public IEnumerator<InvertedIndex.Posting> GetEnumerator()
    {
        var current = Volatile.Read(ref _head);
        while (current is not null)
        {
            yield return current.Value;
            current = current.Next;
        }
    }

    IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
}
