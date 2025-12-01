using Microsoft.AspNetCore.SignalR;
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;

namespace webrtc_dotnetcore.Hubs
{
    public class WebRTCHub : Hub
    {
        private static RoomManager roomManager = new RoomManager();

        public override async Task OnDisconnectedAsync(Exception exception)
        {
            if (roomManager.RemoveParticipant(Context.ConnectionId, out string roomId, out bool removedRoom))
            {
                await Groups.RemoveFromGroupAsync(Context.ConnectionId, roomId);
                await Clients.Group(roomId).SendAsync("peerLeft", Context.ConnectionId);
                await NotifyRoomInfoAsync(false);
            }
            await base.OnDisconnectedAsync(exception);
        }

        public async Task CreateRoom(string name)
        {
            RoomInfo roomInfo = roomManager.CreateRoom(Context.ConnectionId, name);
            if (roomInfo != null)
            {
                await Groups.AddToGroupAsync(Context.ConnectionId, roomInfo.RoomId);
                await Clients.Caller.SendAsync("created", roomInfo.RoomId);
                await NotifyRoomInfoAsync(false);
            }
            else
            {
                await Clients.Caller.SendAsync("error", "خطا در ساخت اتاق جدید.");
            }
        }

        public async Task Join(string roomId)
        {
            if (roomManager.AddParticipant(roomId, Context.ConnectionId, out RoomInfo roomInfo))
            {
                await Groups.AddToGroupAsync(Context.ConnectionId, roomInfo.RoomId);
                await Clients.Caller.SendAsync("joined", roomInfo.RoomId);
                await Clients.Caller.SendAsync("participants", roomManager.GetParticipants(roomId, Context.ConnectionId));
                await Clients.OthersInGroup(roomId).SendAsync("peerJoined", Context.ConnectionId);
                await NotifyRoomInfoAsync(false);
            }
            else
            {
                await Clients.Caller.SendAsync("error", "اتاق مورد نظر یافت نشد.");
            }
        }

        public async Task LeaveRoom(string roomId)
        {
            if (roomManager.RemoveParticipant(Context.ConnectionId, out string removedRoomId, out bool removedRoom))
            {
                await Groups.RemoveFromGroupAsync(Context.ConnectionId, roomId);
                await Clients.Group(roomId).SendAsync("peerLeft", Context.ConnectionId);
                await NotifyRoomInfoAsync(false);
            }
        }

        public async Task GetRoomInfo()
        {
            await NotifyRoomInfoAsync(true);
        }

        public async Task SendSignal(string roomId, string targetConnectionId, object message)
        {
            await Clients.Client(targetConnectionId).SendAsync("signal", new { from = Context.ConnectionId, data = message });
        }

        public async Task NotifyRoomInfoAsync(bool notifyOnlyCaller)
        {
            List<RoomInfo> roomInfos = roomManager.GetAllRoomInfo();
            var list = from room in roomInfos
                       select new
                       {
                           RoomId = room.RoomId,
                           Name = room.Name,
                           ParticipantCount = room.ParticipantCount
                       };
            var data = JsonSerializer.Serialize(list);

            if (notifyOnlyCaller)
            {
                await Clients.Caller.SendAsync("updateRoom", data);
            }
            else
            {
                await Clients.All.SendAsync("updateRoom", data);
            }
        }
    }

    public class RoomManager
    {
        private int nextRoomId;
        private ConcurrentDictionary<int, RoomInfo> rooms;
        private ConcurrentDictionary<string, int> connectionRoomIndex;

        public RoomManager()
        {
            nextRoomId = 1;
            rooms = new ConcurrentDictionary<int, RoomInfo>();
            connectionRoomIndex = new ConcurrentDictionary<string, int>();
        }

        public RoomInfo CreateRoom(string connectionId, string name)
        {
            var roomInfo = new RoomInfo
            {
                RoomId = nextRoomId.ToString(),
                Name = string.IsNullOrWhiteSpace(name) ? $"اتاق {nextRoomId}" : name.Trim(),
                HostConnectionId = connectionId,
                Participants = new ConcurrentDictionary<string, bool>()
            };
            roomInfo.Participants.TryAdd(connectionId, true);

            bool result = rooms.TryAdd(nextRoomId, roomInfo);
            if (result)
            {
                connectionRoomIndex[connectionId] = nextRoomId;
                nextRoomId++;
                return roomInfo;
            }
            else
            {
                return null;
            }
        }

        public bool AddParticipant(string roomId, string connectionId, out RoomInfo roomInfo)
        {
            roomInfo = null;
            if (!int.TryParse(roomId, out int id))
            {
                return false;
            }
            if (!rooms.TryGetValue(id, out roomInfo))
            {
                return false;
            }

            roomInfo.Participants.TryAdd(connectionId, true);
            connectionRoomIndex[connectionId] = id;
            return true;
        }

        public bool RemoveParticipant(string connectionId, out string roomId, out bool removedRoom)
        {
            roomId = null;
            removedRoom = false;
            if (connectionRoomIndex.TryRemove(connectionId, out int id))
            {
                roomId = id.ToString();
                if (rooms.TryGetValue(id, out RoomInfo info))
                {
                    info.Participants.TryRemove(connectionId, out _);
                    if (!info.Participants.Any())
                    {
                        rooms.TryRemove(id, out _);
                        removedRoom = true;
                    }
                }
                return true;
            }
            return false;
        }

        public List<string> GetParticipants(string roomId, string exceptConnectionId)
        {
            if (int.TryParse(roomId, out int id) && rooms.TryGetValue(id, out RoomInfo info))
            {
                return info.Participants.Keys.Where(p => p != exceptConnectionId).ToList();
            }
            return new List<string>();
        }

        public List<RoomInfo> GetAllRoomInfo()
        {
            return rooms.Values.ToList();
        }
    }

    public class RoomInfo
    {
        public string RoomId { get; set; }
        public string Name { get; set; }
        public string HostConnectionId { get; set; }
        public ConcurrentDictionary<string, bool> Participants { get; set; }
        public int ParticipantCount => Participants?.Count ?? 0;
    }
}
