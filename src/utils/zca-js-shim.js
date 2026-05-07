/**
 * zca-js-shim.js
 * Shim thay thế import từ "zca-js" để tương thích với api-zalo local.
 * Cập nhật các giá trị để khớp với core api-zalo (dùng số thay vì string).
 */

export const ThreadType = {
    User: 0,
    Group: 1,
    DirectMessage: 0,
};

export const MessageType = {
    DirectMessage: 0,
    GroupMessage: 1,
};

export const AvatarSize = {
    Small: 120,
    Medium: 240,
    Large: 480,
    ExtraLarge: 960,
};

// Khớp với api-zalo/models/GroupEvent.js
export const GroupEventType = {
    JOIN: 1,
    LEAVE: 2,
    REMOVE_MEMBER: 3,
    UPDATE: 4,
};
