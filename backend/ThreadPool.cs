using System.Collections.Concurrent;

namespace ParallelSearch.Server;

internal sealed class ThreadPool
{
    private readonly ThreadSafeTaskQueue<Action> _tasks = new();
    private readonly Thread[] _workers;
    private readonly object _submitGate = new();
    private readonly object _completionGate = new();
    private readonly ConcurrentQueue<Exception> _taskFailures = new();
    private int _activeTasks;
    private bool _terminated;

    public ThreadPool(int workerCount)
    {
        _workers = new Thread[workerCount];
        for (var i = 0; i < workerCount; i++)
        {
            _workers[i] = new Thread(WorkerLoop)
            {
                Name = $"pool-worker-{i}"
            };
            _workers[i].Start();
        }
    }

    public void Submit(Action task)
    {
        lock (_submitGate)
        {
            ObjectDisposedException.ThrowIf(_terminated, this);
            lock (_completionGate)
            {
                _activeTasks++;
            }

            _tasks.Enqueue(task);
        }
    }

    public void AwaitCompletion()
    {
        lock (_completionGate)
        {
            while (_activeTasks > 0)
            {
                Monitor.Wait(_completionGate);
            }
        }

        if (!_taskFailures.IsEmpty)
        {
            throw new AggregateException("One or more worker tasks failed.", _taskFailures);
        }
    }

    public void Shutdown()
    {
        lock (_submitGate)
        {
            if (_terminated)
            {
                return;
            }

            _terminated = true;
            _tasks.CompleteAdding();
        }

        foreach (var worker in _workers)
        {
            worker.Join();
        }
    }

    private void WorkerLoop()
    {
        while (_tasks.TryTake(out var task))
        {
            try
            {
                task!();
            }
            catch (Exception exception)
            {
                _taskFailures.Enqueue(exception);
            }
            finally
            {
                lock (_completionGate)
                {
                    _activeTasks--;
                    if (_activeTasks == 0)
                    {
                        Monitor.PulseAll(_completionGate);
                    }
                }
            }
        }
    }
}
