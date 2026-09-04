import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  Req,
} from '@nestjs/common';
import { GroupsService } from './groups.service';
import { CreateGroupDto } from './dto/create-group.dto';
import { UpdateGroupDto } from './dto/update-group.dto';
import { JoinGroupDto } from './dto/join-group.dto';
import { AddGuestDto } from './dto/add-guest.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Public } from '../common/decorators/public.decorator';
import { GroupInvitePreview } from './types/group-invite-preview.type';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiSecurity,
} from '@nestjs/swagger';
import { Group, GroupMember } from '@prisma/client';
import type { Request } from 'express';
import '../common/interfaces/request-user.interface';

@ApiTags('groups')
@ApiBearerAuth()
@Controller('groups')
@UseGuards(JwtAuthGuard)
export class GroupsController {
  constructor(private readonly groupsService: GroupsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new group' })
  @ApiResponse({
    status: 201,
    description: 'The group has been successfully created.',
  })
  create(
    @Req() req: Request,
    @Body() createGroupDto: CreateGroupDto,
  ): Promise<Group> {
    const userId = req.user!.id;
    return this.groupsService.create(userId, createGroupDto);
  }

  @Post('join')
  @ApiOperation({ summary: 'Join a group by invite code' })
  @ApiResponse({ status: 201, description: 'Successfully joined the group.' })
  @ApiResponse({ status: 404, description: 'Group not found.' })
  @ApiResponse({ status: 409, description: 'Already a member.' })
  join(
    @Req() req: Request,
    @Body() joinGroupDto: JoinGroupDto,
  ): Promise<GroupMember> {
    const userId = req.user!.id;
    return this.groupsService.join(userId, joinGroupDto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all groups for the authenticated user' })
  @ApiResponse({ status: 200, description: 'Return all groups.' })
  findAll(@Req() req: Request): Promise<Group[]> {
    const userId = req.user!.id;
    return this.groupsService.findAll(userId);
  }

  @Public()
  @ApiSecurity({})
  @Get('preview/:inviteCode')
  @ApiOperation({
    summary: 'Preview a group by invite code (no authentication required)',
  })
  @ApiResponse({
    status: 200,
    description: 'Returns minimal, non-sensitive group info.',
  })
  @ApiResponse({ status: 404, description: 'Invite code not found.' })
  previewByInviteCode(
    @Param('inviteCode') inviteCode: string,
  ): Promise<GroupInvitePreview> {
    return this.groupsService.previewByInviteCode(inviteCode);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a group by id' })
  @ApiResponse({ status: 200, description: 'Return the group.' })
  @ApiResponse({ status: 404, description: 'Group not found.' })
  findOne(@Req() req: Request, @Param('id') id: string): Promise<Group> {
    const userId = req.user!.id;
    return this.groupsService.findOne(id, userId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a group' })
  @ApiResponse({
    status: 200,
    description: 'The group has been successfully updated.',
  })
  @ApiResponse({ status: 403, description: 'Forbidden.' })
  update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() updateGroupDto: UpdateGroupDto,
  ): Promise<Group> {
    const userId = req.user!.id;
    return this.groupsService.update(id, userId, updateGroupDto);
  }

  @Delete(':id/leave')
  @ApiOperation({ summary: 'Leave a group' })
  @ApiResponse({ status: 200, description: 'Successfully left the group.' })
  @ApiResponse({
    status: 403,
    description: 'Unsettled balances or owner cannot leave.',
  })
  @ApiResponse({ status: 404, description: 'Not a member.' })
  leave(@Req() req: Request, @Param('id') id: string): Promise<void> {
    const userId = req.user!.id;
    return this.groupsService.leave(id, userId);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a group' })
  @ApiResponse({
    status: 200,
    description: 'The group has been successfully deleted.',
  })
  @ApiResponse({
    status: 403,
    description: 'Only the owner can delete the group.',
  })
  remove(@Req() req: Request, @Param('id') id: string): Promise<Group> {
    const userId = req.user!.id;
    return this.groupsService.remove(id, userId);
  }

  @Post(':id/guests')
  @ApiOperation({
    summary: 'Add a guest participant (no account) to a group',
  })
  @ApiResponse({ status: 201, description: 'The guest has been added.' })
  @ApiResponse({ status: 403, description: 'Not a member of this group.' })
  addGuest(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() addGuestDto: AddGuestDto,
  ): Promise<GroupMember> {
    const userId = req.user!.id;
    return this.groupsService.addGuest(id, userId, addGuestDto);
  }

  @Patch(':id/guests/:guestId')
  @ApiOperation({ summary: 'Rename a guest participant' })
  @ApiResponse({ status: 200, description: 'The guest has been renamed.' })
  @ApiResponse({ status: 403, description: 'Not a member of this group.' })
  @ApiResponse({ status: 404, description: 'Guest not found.' })
  renameGuest(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('guestId') guestId: string,
    @Body() addGuestDto: AddGuestDto,
  ): Promise<GroupMember> {
    const userId = req.user!.id;
    return this.groupsService.renameGuest(id, userId, guestId, addGuestDto);
  }

  @Delete(':id/guests/:guestId')
  @ApiOperation({ summary: 'Remove a guest participant' })
  @ApiResponse({ status: 200, description: 'The guest has been removed.' })
  @ApiResponse({
    status: 403,
    description:
      'Not a member of this group, or the guest has an unsettled balance.',
  })
  @ApiResponse({ status: 404, description: 'Guest not found.' })
  removeGuest(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('guestId') guestId: string,
  ): Promise<void> {
    const userId = req.user!.id;
    return this.groupsService.removeGuest(id, userId, guestId);
  }
}
